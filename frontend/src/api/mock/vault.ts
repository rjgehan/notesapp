// In-memory vault behind the dev mock. It follows the server's rules closely enough that the UI
// can be built and exercised without the backend: version protocol (API.md §4), name rules,
// case policy, trash, link rewriting on move, backlinks, search, tags, history and events.
import { BLOCK_ID, blockIdsIn, LINE_BLOCK_ID, newBlockId, noteLines, planBlockId } from '../../features/blocks';
import { flattenItems as flattenBookmarkItems, rekeyBookmarks } from '../../features/bookmarks';
import type { TimelineFilter } from '../endpoints';
import { buildLinkIndex, createPath, encodeMdPath, linkText, linkTextRaw, resolve, type LinkIndex } from '../../features/links';
import { extensionOf, folderOf, joinPath, lastSegment, basenameOf, isNotePath, newPathError, pathSafetyError, rebasePath, stripMd } from '../../features/paths';
import { splitWikiBody } from '../../features/syntax';
import { DEFAULT_SETTINGS } from '../../features/settings';
import type {
  AlertTestResult,
  AttachmentResult,
  BacklinkGroup,
  BacklinksResponse,
  BlockIdRequest,
  BlockIdResult,
  BookmarkItem,
  BookmarksResponse,
  BookmarksUpdateRequest,
  ChangeType,
  ChangesResponse,
  CommitResult,
  CompatIssue,
  CompatOccurrence,
  CompatReport,
  CreateFileRequest,
  DeletedFile,
  DeletedFilesResponse,
  FileEntry,
  FileKind,
  FolderResult,
  HeadingRenameRequest,
  HeadingRenameResult,
  HistoryContent,
  HistoryEntry,
  HistoryResponse,
  MirrorStatus,
  HistoryRestoreRequest,
  HistoryRestoreResult,
  Mention,
  MoveRequest,
  MoveResult,
  NoteMeta,
  OnConflict,
  RestoreRequest,
  RestoreResult,
  SaveFileRequest,
  SavedSearch,
  SavedSearchesResponse,
  SavedSearchesUpdateRequest,
  SearchResponse,
  Settings,
  SettingsResponse,
  SettingsUpdateRequest,
  StatusDetails,
  StatusResponse,
  TagCount,
  GraphNode,
  GraphResponse,
  TemplatesResponse,
  TextFile,
  TimelineEntry,
  TimelineFile,
  TimelineResponse,
  TranscriptionResult,
  TranscriptionStatus,
  TrashEntry,
  TreeResponse,
  WriteResult,
} from '../types';
import { MockEventHub } from './events';
import { numbered, sanitizeAttachmentName } from './names';
import { fail } from './problems';
import { isCanvasPath, scanCanvas } from './canvasScan';
import { lineAt, scanNote, type NoteScan, type ScannedLink } from './scan';
import { mockSearch, type SearchDoc } from './search';
import { seedFiles } from './seed';
import { blobId } from './sha1';

const TEXT_LIMIT = 5 * 1024 * 1024;
/** The server's default large-file threshold (DESIGN §5.8): larger files are kept out of history. */
const LARGE_FILE_LIMIT = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set('txt markdown json canvas excalidraw sheet tasks csv tsv yaml yml mdenc'.split(' '));
const KIND_BY_EXT: Record<string, FileKind> = {};
for (const e of 'png jpg jpeg gif webp avif bmp svg'.split(' ')) KIND_BY_EXT[e] = 'image';
for (const e of 'mp3 m4a ogg wav flac 3gp'.split(' ')) KIND_BY_EXT[e] = 'audio';
for (const e of 'mp4 mov ogv webm mkv'.split(' ')) KIND_BY_EXT[e] = 'video';
KIND_BY_EXT.pdf = 'pdf';

export function kindOf(path: string): FileKind {
  const ext = extensionOf(path);
  if (ext === 'md') return 'note';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return KIND_BY_EXT[ext] ?? 'other';
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
  flac: 'audio/flac', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', pdf: 'application/pdf',
  md: 'text/plain', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
};

export function mimeOf(path: string): string {
  return MIME[extensionOf(path)] ?? 'application/octet-stream';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
const BOM = [0xef, 0xbb, 0xbf];

interface StoredFile {
  path: string;
  bytes: Uint8Array;
  mtime: number;
}

interface TrashItem {
  entry: TrashEntry;
  files: StoredFile[];
  folders: string[];
}

interface Commit {
  commitId: string;
  parentCommitId: string | null;
  time: number;
  message: string;
  changes: Array<{ path: string; change: ChangeType; renamedFrom: string | null; bytes: Uint8Array | null }>;
}

const isoMs = (t: number) => new Date(t).toISOString();
const hasBom = (b: Uint8Array) => b.length >= 3 && b[0] === BOM[0] && b[1] === BOM[1] && b[2] === BOM[2];

function decodeText(bytes: Uint8Array): { content: string; lossy: boolean } {
  const body = hasBom(bytes) ? bytes.subarray(3) : bytes;
  let lossy = false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    lossy = true;
  }
  return { content: decoder.decode(body), lossy };
}

function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function trashId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CROCKFORD[b % 32]).join('');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class MockVault {
  readonly hub = new MockEventHub();
  private files = new Map<string, StoredFile>();
  private folders = new Set<string>();
  private trash: TrashItem[] = [];
  private commits: Commit[] = [];
  private scans = new Map<string, { version: string; scan: NoteScan; text: string | null }>();
  private moveLog = new Map<string, string>();
  private idempotency = new Map<string, unknown>();
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private settingsVersion = '';
  private bookmarks: BookmarkItem[] = [];
  private bookmarksVersion = blobId(encoder.encode(JSON.stringify([])));
  private savedSearches: SavedSearch[] = [];
  private savedSearchesVersion: string | null = null;
  private readonly startedAt = Date.now();

  constructor(seed = true) {
    this.settingsVersion = blobId(encoder.encode(JSON.stringify(this.settings)));
    if (!seed) return;
    const now = Date.now();
    for (const f of seedFiles()) {
      this.writeRaw(f.path, encoder.encode(f.content), now - f.age * 60_000);
    }
    this.commit('Initial commit', [...this.files.keys()].map((p) => ({ path: p, change: 'added' as const, renamedFrom: null })));
  }

  // ---------- low-level storage ----------

  private writeRaw(path: string, bytes: Uint8Array, mtime = Date.now()): StoredFile {
    const f: StoredFile = { path, bytes, mtime };
    this.files.set(path, f);
    for (let d = folderOf(path); d !== ''; d = folderOf(d)) this.folders.add(d);
    return f;
  }

  private entry(f: StoredFile): FileEntry {
    const kind = kindOf(f.path);
    const textKind = kind === 'note' || kind === 'text';
    const version = textKind && f.bytes.length <= TEXT_LIMIT ? blobId(f.bytes) : null;
    return {
      path: f.path,
      name: lastSegment(f.path),
      basename: basenameOf(f.path),
      extension: extensionOf(f.path),
      kind,
      size: f.bytes.length,
      mtime: isoMs(f.mtime),
      version,
      aliases: kind === 'note' && version ? this.scanOf(f).aliases : [],
    };
  }

  private scanOf(f: StoredFile): NoteScan {
    return this.indexOf(f).scan;
  }

  /** A note's parse, or a canvas's (over its searchable text, like the server's CanvasIndexer). */
  private indexOf(f: StoredFile): { scan: NoteScan; text: string | null } {
    const version = blobId(f.bytes);
    const cached = this.scans.get(f.path);
    if (cached && cached.version === version) return cached;
    const content = decodeText(f.bytes).content;
    const entry = isCanvasPath(f.path) ? { version, ...scanCanvas(content) } : { version, scan: scanNote(content), text: null };
    this.scans.set(f.path, entry);
    return entry;
  }

  /** The text search and backlink contexts read: a canvas's searchable text, a note's content. */
  private indexTextOf(f: StoredFile): string {
    return this.indexOf(f).text ?? this.textOf(f);
  }

  private textOf(f: StoredFile): string {
    return decodeText(f.bytes).content;
  }

  private notes(): StoredFile[] {
    return [...this.files.values()].filter((f) => kindOf(f.path) === 'note');
  }

  /** Notes and canvases: what search, backlinks and tags read. */
  private indexed(): StoredFile[] {
    return [...this.files.values()].filter((f) => kindOf(f.path) === 'note' || (isCanvasPath(f.path) && f.bytes.length <= TEXT_LIMIT));
  }

  private linkIndex(paths: Iterable<string> = this.files.keys()): LinkIndex {
    return buildLinkIndex(paths);
  }

  /** EXISTING-mode lookup: exact-case, with the server's error codes. */
  private existing(path: string): StoredFile {
    const err = pathSafetyError(path);
    if (err) {
      if (path.split('/').some((s) => s.startsWith('.') && s !== '.' && s !== '..')) fail('reserved-path', 'Reserved path', { path });
      fail('invalid-path', err, { path });
    }
    const f = this.files.get(path);
    if (f) return f;
    if (this.folders.has(path)) fail('type-mismatch', 'A folder exists at this path', { path, expected: 'file' });
    return fail('not-found', 'No such file', { path });
  }

  private checkNew(path: string): void {
    const safety = pathSafetyError(path);
    if (safety) {
      if (path.split('/').some((s) => s.startsWith('.') && s.length > 0 && s !== '.' && s !== '..')) fail('reserved-path', 'Reserved path', { path });
      fail('invalid-path', safety, { path });
    }
    const err = newPathError(path);
    if (err) fail('invalid-name', err, { path });
  }

  /** Implicit parent folders resolve case-insensitively to existing folders. */
  private canonicalParents(path: string): string {
    const segs = path.split('/');
    let folder = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const candidate = joinPath(folder, segs[i]);
      const existingFolder = [...this.folders].find((d) => d.toLowerCase() === candidate.toLowerCase());
      if (!existingFolder && this.findIgnoreCase(candidate)) fail('type-mismatch', 'A parent segment is a file', { path, expected: 'folder' });
      folder = existingFolder ?? candidate;
    }
    return joinPath(folder, segs[segs.length - 1]);
  }

  private findIgnoreCase(path: string): string | null {
    const lower = path.toLowerCase();
    for (const p of this.files.keys()) if (p.toLowerCase() === lower) return p;
    for (const d of this.folders) if (d.toLowerCase() === lower) return d;
    return null;
  }

  private missingParents(path: string): string[] {
    const out: string[] = [];
    for (let d = folderOf(path); d !== '' && !this.folders.has(d); d = folderOf(d)) out.unshift(d);
    return out;
  }

  private publishFolders(created: string[], origin: string | null): void {
    for (const path of created) this.hub.publish('folder.created', { path, origin }, origin);
  }

  private commit(message: string, changes: Array<{ path: string; change: ChangeType; renamedFrom: string | null }>): string | null {
    if (changes.length === 0) return null;
    const commitId = randomHex(40);
    const commit: Commit = {
      commitId,
      parentCommitId: this.commits.length ? this.commits[this.commits.length - 1].commitId : null,
      time: Date.now(),
      message,
      changes: changes.map((c) => ({ ...c, bytes: c.change === 'deleted' ? null : (this.files.get(c.path)?.bytes ?? null) })),
    };
    this.commits.push(commit);
    this.hub.publish(
      'history.committed',
      { commitId, message, authorName: 'Owner', time: isoMs(commit.time), paths: changes.map((c) => c.path).slice(0, 100), truncated: changes.length > 100 },
      null,
      false,
    );
    return commitId;
  }

  private idempotent<T>(key: string | undefined, scope: string, run: () => T): T {
    if (!key) return run();
    const k = `${scope}:${key}`;
    if (this.idempotency.has(k)) return structuredClone(this.idempotency.get(k)) as T;
    const result = run();
    this.idempotency.set(k, structuredClone(result));
    return result;
  }

  private freeName(path: string, onConflict: OnConflict | 'overwrite'): string {
    const taken = (p: string) => this.findIgnoreCase(p) !== null;
    if (!taken(path)) return path;
    if (onConflict === 'rename') {
      for (let n = 1; n <= 999; n++) {
        const candidate = joinPath(folderOf(path), numbered(lastSegment(path), n));
        if (!taken(candidate)) return candidate;
      }
    }
    const existingPath = this.findIgnoreCase(path)!;
    if (existingPath === path) fail('already-exists', 'The target path exists', { path, existingPath });
    return fail('case-collision', 'A file with the same name (different case) exists', { path, existingPath });
  }

  // ---------- settings, identity, status ----------

  getSettings(): SettingsResponse {
    return { settings: structuredClone(this.settings), version: this.settingsVersion, readOnly: false };
  }

  putSettings(req: SettingsUpdateRequest, origin: string): SettingsResponse {
    if (req.baseVersion !== this.settingsVersion) {
      fail('version-conflict', 'Settings changed on the server', {
        path: '.notesapp/settings.json',
        currentVersion: this.settingsVersion,
        currentContent: JSON.stringify(this.settings),
        currentMtime: isoMs(Date.now()),
        movedTo: null,
      });
    }
    this.settings = structuredClone(req.settings);
    this.settingsVersion = blobId(encoder.encode(JSON.stringify(this.settings)));
    this.hub.publish('settings.changed', { version: this.settingsVersion, origin }, origin);
    return this.getSettings();
  }

  // ---------- heading renames (API.md §22) ----------

  renameHeading(req: HeadingRenameRequest, origin: string | null): HeadingRenameResult {
    const note = this.existing(req.path);
    const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const from = req.from.trim();
    const to = req.to.trim();
    if (!from || !to || key(from) === key(to)) fail('bad-request', 'Invalid heading rename', { errors: [{ field: 'to', message: 'must differ' }] });
    const headings = this.scanOf(note).headings.map((h) => key(h.text));
    if (headings.includes(key(from)) || !headings.includes(key(to))) fail('bad-request', 'The note must have the new heading and not the old one', { errors: [] });
    const index = this.linkIndex();
    const linkUpdates: HeadingRenameResult['linkUpdates'] = [];
    const rewrites: Array<{ path: string; text: string }> = [];
    for (const source of this.notes()) {
      let text = this.textOf(source);
      let count = 0;
      for (const link of [...this.scanOf(source).links].sort((a, b) => b.from - a.from)) {
        if (link.subpath === null) continue;
        const resolved = link.target === '' ? source.path : resolve(link.target, source.path, index);
        if (resolved !== req.path) continue;
        const span = headingSubpathSpan(text, link);
        if (!span) continue;
        const decode = link.style === 'markdown' && !link.angle;
        let matched = false;
        const segments = text.slice(span[0], span[1]).split('#').map((seg) => {
          const plain = decode ? safeDecode(seg) : seg;
          if (plain.startsWith('^') || key(plain) !== key(from)) return seg;
          matched = true;
          return decode ? encodeMdPath(to) : to;
        });
        if (!matched || (link.style === 'wiki' && /[|#[\]]/.test(to))) continue;
        text = text.slice(0, span[0]) + segments.join('#') + text.slice(span[1]);
        count++;
      }
      if (count > 0) {
        rewrites.push({ path: source.path, text });
        linkUpdates.push({ path: source.path, links: count, version: null });
      }
    }
    const bookmarks = this.renameHeadingBookmarks(req.path, from, to, req.dryRun ?? false);
    if (req.dryRun) return { dryRun: true, path: req.path, from, to, linkUpdates, failed: [], bookmarks, commitId: null };
    for (const r of rewrites) {
      const file = this.entry(this.writeRaw(r.path, encoder.encode(r.text)));
      linkUpdates.find((u) => u.path === r.path)!.version = file.version;
      this.hub.publish('file.changed', { file, origin }, origin);
    }
    const commitId = rewrites.length
      ? this.commit(`Update links after renaming heading “${from}” → “${to}” in ${req.path} (${rewrites.length} notes)`, rewrites.map((r) => ({ path: r.path, change: 'modified' as const, renamedFrom: null })))
      : null;
    return { dryRun: false, path: req.path, from, to, linkUpdates, failed: [], bookmarks, commitId };
  }

  // ---------- block ids (API.md §37) ----------

  addBlockId(req: BlockIdRequest, origin: string | null): BlockIdResult {
    const note = this.existing(req.path);
    if (!isNotePath(note.path)) fail('type-mismatch', 'Block ids belong in notes', { path: note.path, expected: 'note' });
    if (req.placement !== 'end' && req.placement !== 'after') fail('bad-request', 'Invalid placement', { errors: [{ field: 'placement', message: 'invalid' }] });
    if (req.id !== undefined && !BLOCK_ID.test(req.id)) fail('bad-request', 'Invalid id', { errors: [{ field: 'id', message: 'invalid' }] });
    const text = this.textOf(note);
    const taken = blockIdsIn(text);
    const wanted = req.id !== undefined && !taken.some((t) => t.toLowerCase() === req.id!.toLowerCase()) ? req.id : newBlockId(taken);
    const plan = planBlockId(text, req, wanted);
    if (plan.kind === 'missing') fail('block-not-found', 'The block changed since it was read', { path: note.path });
    if (plan.kind === 'existing') return { id: plan.id, created: false, line: lineOf(text, plan.id), file: this.entry(note) };
    const next = text.slice(0, plan.from) + plan.insert + text.slice(plan.from);
    const file = this.entry(this.writeRaw(note.path, encoder.encode(next)));
    this.hub.publish('file.changed', { file, origin }, origin);
    return { id: plan.id, created: true, line: lineOf(next, plan.id), file };
  }

  private renameHeadingBookmarks(path: string, from: string, to: string, dryRun: boolean): number {
    const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    let count = 0;
    const visit = (items: BookmarkItem[]): BookmarkItem[] =>
      items.map((item) => {
        if (item.type === 'group' && Array.isArray(item.items)) return { ...item, items: visit(item.items) };
        if (item.type !== 'file' || typeof item.path !== 'string' || typeof item.subpath !== 'string' || item.path.toLowerCase() !== path.toLowerCase()) return item;
        const segments = item.subpath.split('#');
        let changed = false;
        for (let i = 1; i < segments.length; i++) {
          if (!segments[i].startsWith('^') && key(segments[i]) === key(from)) {
            segments[i] = to;
            changed = true;
          }
        }
        if (!changed) return item;
        count++;
        return { ...item, subpath: segments.join('#') };
      });
    const next = visit(this.bookmarks);
    if (count > 0 && !dryRun) this.setBookmarks(next, null);
    return count;
  }

  // ---------- bookmarks (API.md §21) ----------

  getBookmarks(): BookmarksResponse {
    return { version: this.bookmarksVersion, items: structuredClone(this.bookmarks) };
  }

  putBookmarks(req: BookmarksUpdateRequest, origin: string): BookmarksResponse {
    const nextVersion = blobId(encoder.encode(JSON.stringify(req.items)));
    if (nextVersion === this.bookmarksVersion) return this.getBookmarks();
    if (req.baseVersion !== this.bookmarksVersion) {
      fail('version-conflict', 'Bookmarks changed on the server', {
        path: '.notesapp/bookmarks.json',
        currentVersion: this.bookmarksVersion,
        currentContent: JSON.stringify({ items: this.bookmarks }),
        currentMtime: isoMs(Date.now()),
        movedTo: null,
      });
    }
    for (const { item } of flattenBookmarkItems(req.items)) {
      if (typeof item.path === 'string' && pathSafetyError(item.path)) fail('bad-request', 'Invalid bookmarks', { errors: [{ field: 'items', message: 'invalid path' }] });
    }
    this.setBookmarks(req.items, origin);
    return this.getBookmarks();
  }

  private setBookmarks(items: BookmarkItem[], origin: string | null): void {
    this.bookmarks = structuredClone(items);
    this.bookmarksVersion = blobId(encoder.encode(JSON.stringify(this.bookmarks)));
    this.hub.publish('bookmarks.changed', { version: this.bookmarksVersion, origin }, origin);
  }

  /** Bookmarks follow a move or a restore elsewhere, as the server re-keys them (origin null: every client hears). */
  private rekeyBookmarks(from: string, to: string, type: 'file' | 'folder'): void {
    const next = rekeyBookmarks(this.bookmarks, from, to, type, (p) => this.files.has(p) || this.folders.has(p));
    if (next) this.setBookmarks(next, null);
  }

  getStatus(): StatusResponse {
    const files = [...this.files.values()];
    const last = this.commits[this.commits.length - 1];
    const large = files.filter((f) => f.bytes.length > LARGE_FILE_LIMIT);
    return {
      appVersion: '0.0.1-mock',
      buildSha: this.hub.buildSha,
      bootId: this.hub.bootId,
      startedAt: isoMs(this.startedAt),
      eventId: this.hub.head(),
      vault: {
        notes: files.filter((f) => kindOf(f.path) === 'note').length,
        files: files.length,
        folders: this.folders.size,
        bytes: files.reduce((n, f) => n + f.bytes.length, 0),
        skipped: [],
        unwritableDirs: [],
      },
      index: { builtInMs: 3, lastRescanAt: null },
      git: {
        enabled: true,
        state: 'ready',
        reason: null,
        head: last?.commitId ?? null,
        pendingPaths: 0,
        nextCommitAt: null,
        lastCommitAt: last ? isoMs(last.time) : null,
        lastError: null,
        failingSince: null,
        largeFiles: {
          limitBytes: LARGE_FILE_LIMIT,
          files: large.length,
          bytes: large.reduce((n, f) => n + f.bytes.length, 0),
        },
      },
      watcher: { mode: 'disabled' },
      disk: { freeBytes: 50 * 1024 ** 3, repoBytes: null },
      settings: { readOnly: false, reason: null },
      mirror: this.mirrorStatus(),
    };
  }

  /** What a server without backups or ntfy reports (API.md §6.5). */
  getStatusDetails(): StatusDetails {
    const large = [...this.files.values()]
      .filter((f) => f.bytes.length > LARGE_FILE_LIMIT)
      .sort((a, b) => b.bytes.length - a.bytes.length);
    return {
      runtime: { javaVersion: 'mock', javaVendor: 'in-memory', aotCache: 'off', heapUsedBytes: 0, heapMaxBytes: 0, processors: 1 },
      events: { clients: this.hub.clientCount() },
      git: {
        commits: this.commits.length,
        commitsThisRun: this.commits.length,
        failedCommitsThisRun: 0,
        largeFiles: large.slice(0, 100).map((f) => ({ path: f.path, bytes: f.bytes.length })),
        largeFilesTruncated: large.length > 100,
      },
      disk: { totalBytes: 100 * 1024 ** 3 },
      backup: { state: 'unknown', reason: 'The mock has no backups', lastRun: null, lastSuccess: null, snapshot: null, offsite: null, failures: null },
      alerts: { state: 'off', reason: 'not configured', server: null, sent: 0, dropped: 0, lastSentAt: null, lastError: null, lastErrorAt: null, recent: [] },
    };
  }

  /** The mock has no ntfy.json, like a server without alerts (API.md §6.6). */
  sendTestAlert(): AlertTestResult {
    return fail('bad-request', 'App alerts are off: not configured');
  }

  /** The mock has no mirror: it reports what an unconfigured server does. */
  private mirrorStatus(): MirrorStatus {
    return {
      state: 'disabled',
      reason: 'not configured',
      remote: null,
      branch: null,
      pushing: false,
      pushedCommit: null,
      lastPushAt: null,
      nextPushAt: null,
      lastError: null,
      failingSince: null,
    };
  }

  pushMirror(): MirrorStatus {
    return fail('bad-request', 'The mirror is off: not configured');
  }

  // ---------- voice notes (API.md §23) ----------

  /** The mock transcribes like a configured service; tests turn it off. */
  transcriptionEnabled = true;

  getTranscriptionStatus(): TranscriptionStatus {
    return { enabled: this.transcriptionEnabled, service: this.transcriptionEnabled ? 'mock' : null, language: null, maxBytes: 25 * 1024 * 1024 };
  }

  transcribe(path: string): TranscriptionResult {
    if (!this.transcriptionEnabled) fail('transcription-off', 'Transcription is off: no transcription service is configured (NOTES_TRANSCRIPTION_URL)');
    const f = this.existing(path);
    const kind = kindOf(path);
    if (kind !== 'audio' && kind !== 'video') fail('not-audio', 'Only audio and video files can be transcribed', { path });
    return { path, text: `Transcript of ${lastSegment(path)} (${f.bytes.length} bytes).`, language: 'en', millis: 1 };
  }

  // ---------- tree and text files ----------

  getTree(): TreeResponse {
    const eventId = this.hub.head();
    const folders = [...this.folders]
      .sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b))
      .map((path) => ({ path, name: lastSegment(path) }));
    const files = [...this.files.values()].map((f) => this.entry(f)).sort((a, b) => cmp(a.path, b.path));
    return { eventId, folders, files };
  }

  readFile(path: string): TextFile {
    const f = this.existing(path);
    const kind = kindOf(path);
    if (kind !== 'note' && kind !== 'text') fail('not-text', 'Not a text file', { path, kind });
    if (f.bytes.length > TEXT_LIMIT) fail('too-large', 'File too large', { limit: TEXT_LIMIT });
    const { content, lossy } = decodeText(f.bytes);
    return { path, kind, content, version: blobId(f.bytes), size: f.bytes.length, mtime: isoMs(f.mtime), lossy };
  }

  createFile(req: CreateFileRequest, origin: string | null, idempotencyKey?: string): WriteResult {
    return this.idempotent(idempotencyKey, 'POST /api/files', () => {
      this.checkNew(req.path);
      const kind = kindOf(req.path);
      if (kind !== 'note' && kind !== 'text') fail('not-text', 'Only text files can be created here', { path: req.path, kind });
      const path = this.freeName(this.canonicalParents(req.path.normalize('NFC')), req.onConflict ?? 'fail');
      const created = this.missingParents(path);
      const f = this.writeRaw(path, encoder.encode(req.content ?? ''));
      this.publishFolders(created, origin);
      const file = this.entry(f);
      this.hub.publish('file.created', { file, origin }, origin);
      this.commit(`Create ${path}`, [{ path, change: 'added', renamedFrom: null }]);
      return { file, created: true, createdFolders: created };
    });
  }

  saveFile(path: string, req: SaveFileRequest, origin: string | null): WriteResult {
    const err = pathSafetyError(path);
    if (err) fail('invalid-path', err, { path });
    const kind = kindOf(path);
    if (kind !== 'note' && kind !== 'text') fail('not-text', 'Not a text file', { path, kind });
    const existing = this.files.get(path);
    const baseVersion = req.baseVersion ?? null;
    if (!existing) {
      if (this.folders.has(path)) fail('type-mismatch', 'A folder exists at this path', { path, expected: 'file' });
      if (baseVersion !== null) {
        fail('version-conflict', 'File was deleted or moved', {
          path,
          currentVersion: null,
          currentContent: null,
          currentMtime: null,
          movedTo: this.moveLog.get(path.toLowerCase()) ?? null,
        });
      }
      const target = this.canonicalParents(path);
      const clash = this.findIgnoreCase(target);
      if (clash) fail('case-collision', 'A file with the same name (different case) exists', { path, existingPath: clash });
      const created = this.missingParents(target);
      const f = this.writeRaw(target, encoder.encode(req.content));
      this.publishFolders(created, origin);
      const file = this.entry(f);
      this.hub.publish('file.created', { file, origin }, origin);
      this.commit(`Create ${target}`, [{ path: target, change: 'added', renamedFrom: null }]);
      return { file, created: true, createdFolders: created };
    }
    const bom = hasBom(existing.bytes);
    const body = encoder.encode(req.content);
    const bytes = bom ? new Uint8Array([...BOM, ...body]) : body;
    if (bytes.length > TEXT_LIMIT) fail('too-large', 'File too large', { limit: TEXT_LIMIT });
    if (sameBytes(bytes, existing.bytes)) return { file: this.entry(existing), created: false, createdFolders: [] };
    const current = blobId(existing.bytes);
    if (baseVersion !== current) {
      fail('version-conflict', 'File changed on the server', {
        path,
        currentVersion: current,
        currentContent: this.textOf(existing),
        currentMtime: isoMs(existing.mtime),
        movedTo: null,
      });
    }
    const f = this.writeRaw(path, bytes);
    const file = this.entry(f);
    this.hub.publish('file.changed', { file, origin }, origin);
    this.commit(`Update ${path}`, [{ path, change: 'modified', renamedFrom: null }]);
    return { file, created: false, createdFolders: [] };
  }

  /** Bytes of a file for the raw endpoint (blob URLs in the mock). */
  rawBytes(path: string): Uint8Array | null {
    return this.files.get(path)?.bytes ?? null;
  }

  async uploadRaw(path: string, body: Blob, onConflict: OnConflict | 'overwrite', origin: string | null, key?: string): Promise<WriteResult> {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return this.idempotent(key, 'PUT /api/files/raw', () => {
      this.checkNew(path);
      const canonical = this.canonicalParents(path);
      const existing = this.files.get(canonical);
      if (existing && onConflict === 'overwrite') {
        const kind = kindOf(canonical);
        if (kind === 'note' || kind === 'text') fail('bad-request', 'Use PUT /api/files to overwrite text files');
        const f = this.writeRaw(canonical, bytes);
        const file = this.entry(f);
        this.hub.publish('file.changed', { file, origin }, origin);
        this.commit(`Update ${canonical}`, [{ path: canonical, change: 'modified', renamedFrom: null }]);
        return { file, created: false, createdFolders: [] };
      }
      const target = this.freeName(canonical, onConflict === 'overwrite' ? 'fail' : onConflict);
      const created = this.missingParents(target);
      const f = this.writeRaw(target, bytes);
      this.publishFolders(created, origin);
      const file = this.entry(f);
      this.hub.publish('file.created', { file, origin }, origin);
      this.commit(`Add ${target}`, [{ path: target, change: 'added', renamedFrom: null }]);
      return { file, created: true, createdFolders: created };
    });
  }

  async uploadAttachment(name: string, source: string | null, body: Blob, origin: string | null, key?: string): Promise<AttachmentResult> {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return this.idempotent(key, 'POST /api/attachments', () => {
      if (!name) fail('bad-request', 'Missing name', { errors: [{ field: 'name', message: 'required' }] });
      const clean = sanitizeAttachmentName(name);
      const s = this.settings.files;
      const sourceFolder = source ? folderOf(source) : '';
      const folder =
        s.attachmentLocation === 'root'
          ? ''
          : s.attachmentLocation === 'folder'
            ? s.attachmentFolder
            : s.attachmentLocation === 'current'
              ? sourceFolder
              : joinPath(sourceFolder, s.attachmentSubfolder);
      const target = this.freeName(this.canonicalParents(joinPath(folder, clean)), 'rename');
      const created = this.missingParents(target);
      const f = this.writeRaw(target, bytes);
      this.publishFolders(created, origin);
      const file = this.entry(f);
      this.hub.publish('file.created', { file, origin }, origin);
      this.commit(`Add ${target}`, [{ path: target, change: 'added', renamedFrom: null }]);
      const index = this.linkIndex();
      const src = source ?? lastSegment(target);
      const wikiText = linkText(target, src, s.newLinkFormat, 'wiki', index);
      const markdown = s.useWikilinks
        ? `![[${wikiText}]]`
        : `![](${linkText(target, src, s.newLinkFormat, 'markdown', index)})`;
      return { file, created: true, createdFolders: created, linkText: wikiText, markdown };
    });
  }

  // ---------- folders, trash ----------

  createFolder(path: string, origin: string | null): FolderResult {
    this.checkNew(path);
    const canonical = this.canonicalParents(path);
    const clash = this.findIgnoreCase(canonical);
    if (clash) {
      if (this.files.has(clash)) fail('type-mismatch', 'A file exists at this path', { path, expected: 'folder' });
      fail(clash === canonical ? 'already-exists' : 'case-collision', 'The folder exists', { path, existingPath: clash });
    }
    const created = [...this.missingParents(canonical), canonical];
    for (const d of created) this.folders.add(d);
    this.publishFolders(created, origin);
    return { folder: { path: canonical, name: lastSegment(canonical) }, createdFolders: created };
  }

  deleteFile(path: string, origin: string | null): TrashEntry {
    const f = this.existing(path);
    const entry: TrashEntry = {
      id: trashId(),
      originalPath: path,
      type: 'file',
      deletedAt: isoMs(Date.now()),
      deletedBy: 'owner@notes',
      size: f.bytes.length,
      fileCount: 1,
    };
    this.files.delete(path);
    this.trash.unshift({ entry, files: [f], folders: [] });
    this.hub.publish('file.deleted', { path, trashed: true, trashId: entry.id, origin }, origin);
    this.hub.publish('trash.changed', {}, origin, false);
    this.commit(`Delete ${path}`, [{ path, change: 'deleted', renamedFrom: null }]);
    return entry;
  }

  deleteFolder(path: string, origin: string | null): TrashEntry {
    if (!this.folders.has(path)) {
      if (this.files.has(path)) fail('type-mismatch', 'A file exists at this path', { path, expected: 'folder' });
      fail('not-found', 'No such folder', { path });
    }
    const files = [...this.files.values()].filter((f) => f.path.startsWith(path + '/'));
    const folders = [...this.folders].filter((d) => d === path || d.startsWith(path + '/'));
    for (const f of files) this.files.delete(f.path);
    for (const d of folders) this.folders.delete(d);
    const entry: TrashEntry = {
      id: trashId(),
      originalPath: path,
      type: 'folder',
      deletedAt: isoMs(Date.now()),
      deletedBy: 'owner@notes',
      size: files.reduce((n, f) => n + f.bytes.length, 0),
      fileCount: files.length,
    };
    this.trash.unshift({ entry, files, folders });
    this.hub.publish('folder.deleted', { path, trashed: true, trashId: entry.id, origin }, origin);
    this.hub.publish('trash.changed', {}, origin, false);
    this.commit(`Delete ${path}`, files.map((f) => ({ path: f.path, change: 'deleted' as const, renamedFrom: null })));
    return entry;
  }

  listTrash(): TrashEntry[] {
    return this.trash.map((t) => t.entry);
  }

  trashBytes(id: string): { path: string; bytes: Uint8Array } | null {
    const item = this.trash.find((t) => t.entry.id === id);
    if (!item || item.entry.type !== 'file') return null;
    return { path: item.files[0].path, bytes: item.files[0].bytes };
  }

  restoreTrash(id: string, req: RestoreRequest | undefined, origin: string | null): RestoreResult {
    const idx = this.trash.findIndex((t) => t.entry.id === id);
    if (idx < 0) fail('not-found', 'No such trash entry');
    const item = this.trash[idx];
    const original = item.entry.originalPath;
    let target = req?.to ?? original;
    if (req?.to) this.checkNew(req.to);
    target = this.freeName(this.canonicalParents(target), req?.onConflict ?? 'fail');
    const createdFolders = this.missingParents(target);
    const restored: FileEntry[] = [];
    if (item.entry.type === 'file') {
      const f = this.writeRaw(target, item.files[0].bytes);
      restored.push(this.entry(f));
    } else {
      for (const d of item.folders) {
        const next = rebasePath(d, original, target)!;
        if (!this.folders.has(next)) createdFolders.push(next);
        this.folders.add(next);
      }
      for (const f of item.files) restored.push(this.entry(this.writeRaw(rebasePath(f.path, original, target)!, f.bytes)));
    }
    this.trash.splice(idx, 1);
    this.publishFolders(createdFolders, origin);
    if (restored.length > 50) this.hub.publish('resync', { reason: 'bulk-change' }, origin, false);
    else for (const file of restored) this.hub.publish('file.created', { file, origin }, origin);
    if (target !== original && !this.files.has(original) && !this.folders.has(original)) this.rekeyBookmarks(original, target, item.entry.type);
    this.hub.publish('trash.changed', {}, origin, false);
    const commitId = this.commit(
      `Restore ${target}`,
      restored.map((f) => ({ path: f.path, change: 'added' as const, renamedFrom: null })),
    );
    return { type: item.entry.type, path: target, files: restored, createdFolders, commitId };
  }

  purgeTrash(id: string | null, origin: string | null): number {
    const before = this.trash.length;
    this.trash = id === null ? [] : this.trash.filter((t) => t.entry.id !== id);
    if (id !== null && this.trash.length === before) fail('not-found', 'No such trash entry');
    this.hub.publish('trash.changed', {}, origin, false);
    return before - this.trash.length;
  }

  // ---------- move with link rewriting (DESIGN §5.6) ----------

  move(req: MoveRequest, origin: string | null): MoveResult {
    const { from } = req;
    const updateLinks = req.updateLinks ?? this.settings.files.autoUpdateLinks;
    const dryRun = req.dryRun ?? false;
    const isFolder = this.folders.has(from);
    if (!isFolder) this.existing(from);
    this.checkNew(req.to);
    const to = this.canonicalParents(req.to.normalize('NFC'));
    if (isFolder && (to === from || to.startsWith(from + '/'))) fail('move-into-self', 'Cannot move a folder into itself', { from, to });
    const clash = this.findIgnoreCase(to);
    const caseOnly = clash !== null && clash.toLowerCase() === from.toLowerCase() && to !== from;
    if (clash && !caseOnly) {
      fail(clash === to ? 'already-exists' : 'case-collision', 'The target exists', { path: to, existingPath: clash });
    }

    const moved: Array<{ from: string; to: string }> = isFolder
      ? [...this.files.keys()].filter((p) => p.startsWith(from + '/')).sort().map((p) => ({ from: p, to: rebasePath(p, from, to)! }))
      : [{ from, to }];
    const movedMap = new Map(moved.map((m) => [m.from, m.to]));
    const mapPath = (p: string) => movedMap.get(p) ?? p;

    const oldIndex = this.linkIndex();
    const newIndex = this.linkIndex([...this.files.keys()].map(mapPath));
    const format = this.settings.files.newLinkFormat;
    const plans = new Map<string, Array<{ link: ScannedLink; text: string }>>();
    if (updateLinks) {
      for (const note of this.notes()) {
        const scan = this.scanOf(note);
        const newSource = mapPath(note.path);
        for (const link of scan.links) {
          const before = resolve(link.target, note.path, oldIndex);
          if (before === null || link.target === '') continue;
          const expected = mapPath(before);
          const after = resolve(link.target, newSource, newIndex);
          if (!movedMap.has(before) && after === expected) continue;
          const replacement =
            link.style === 'wiki' || link.angle
              ? linkTextRaw(expected, newSource, format, link.style, newIndex)
              : linkText(expected, newSource, format, 'markdown', newIndex);
          const list = plans.get(note.path) ?? [];
          list.push({ link, text: replacement });
          plans.set(note.path, list);
        }
      }
    }

    const linkUpdates: MoveResult['linkUpdates'] = [];
    const rewrites: Array<{ path: string; text: string }> = [];
    for (const [oldPath, edits] of plans) {
      const note = this.files.get(oldPath)!;
      let text = this.textOf(note);
      let count = 0;
      for (const { link, text: replacement } of [...edits].sort((a, b) => b.link.from - a.link.from)) {
        const [tFrom, tTo] = this.targetSpan(text, link);
        if (text.slice(tFrom, tTo) === replacement) continue;
        text = text.slice(0, tFrom) + replacement + text.slice(tTo);
        count++;
      }
      if (count > 0) {
        rewrites.push({ path: mapPath(oldPath), text });
        linkUpdates.push({ path: mapPath(oldPath), links: count, version: null });
      }
    }

    if (dryRun) {
      return { dryRun: true, type: isFolder ? 'folder' : 'file', from, to, moved, createdFolders: [], linkUpdates, failed: [], commitId: null };
    }

    const createdFolders = this.missingParents(to);
    for (const m of moved) {
      const f = this.files.get(m.from)!;
      this.files.delete(m.from);
      this.scans.delete(m.from);
      this.writeRaw(m.to, f.bytes, f.mtime);
      this.moveLog.set(m.from.toLowerCase(), m.to);
      for (const [k, v] of this.moveLog) if (v === m.from) this.moveLog.set(k, m.to);
    }
    if (isFolder) {
      for (const d of [...this.folders]) {
        const next = rebasePath(d, from, to);
        if (next !== null) {
          this.folders.delete(d);
          this.folders.add(next);
        }
      }
    }
    this.publishFolders(createdFolders, origin);
    this.hub.publish('entry.moved', { from, to, type: isFolder ? 'folder' : 'file', origin }, origin);
    let commitId = this.commit(
      `Rename ${from} → ${to}`,
      moved.map((m) => ({ path: m.to, change: 'renamed' as const, renamedFrom: m.from })),
    );
    for (const r of rewrites) {
      const f = this.writeRaw(r.path, encoder.encode(r.text));
      const file = this.entry(f);
      const update = linkUpdates.find((u) => u.path === r.path)!;
      update.version = file.version;
      this.hub.publish('file.changed', { file, origin }, origin);
    }
    this.rekeyBookmarks(from, to, isFolder ? 'folder' : 'file');
    if (rewrites.length) {
      commitId = this.commit(
        `Update links after renaming ${from} → ${to} (${rewrites.length} notes)`,
        rewrites.map((r) => ({ path: r.path, change: 'modified' as const, renamedFrom: null })),
      );
    }
    return { dryRun: false, type: isFolder ? 'folder' : 'file', from, to, moved, createdFolders, linkUpdates, failed: [], commitId };
  }

  /** The span of a link's target text inside the note (subpath and display excluded). */
  private targetSpan(text: string, link: ScannedLink): [number, number] {
    if (link.style === 'wiki') {
      const body = text.slice(link.targetFrom, link.targetTo);
      const split = splitWikiBody(body);
      const end = split.hashAt >= 0 ? split.hashAt : split.sepFrom >= 0 ? split.sepFrom : body.length;
      const left = body.slice(0, end);
      const lead = left.length - left.trimStart().length;
      const trail = left.length - left.trimEnd().length;
      return [link.targetFrom + lead, link.targetFrom + end - trail];
    }
    const dest = text.slice(link.targetFrom, link.targetTo);
    const hash = dest.indexOf('#');
    return [link.targetFrom, hash >= 0 ? link.targetFrom + hash : link.targetTo];
  }

  // ---------- notes and links ----------

  getNoteMeta(path: string): NoteMeta {
    const f = this.existing(path);
    if (kindOf(path) !== 'note') fail('type-mismatch', 'Not a note', { path, expected: 'note' });
    const scan = this.scanOf(f);
    const index = this.linkIndex();
    return {
      path,
      version: blobId(f.bytes),
      frontmatter: scan.frontmatter,
      frontmatterError: scan.frontmatterError,
      aliases: scan.aliases,
      tags: scan.tags,
      headings: scan.headings,
      blockIds: scan.blockIds,
      links: scan.links.map((l) => ({
        raw: l.raw,
        target: l.target,
        subpath: l.subpath,
        display: l.display,
        embed: l.embed,
        style: l.style,
        line: l.line,
        from: l.from,
        to: l.to,
        inFrontmatter: l.inFrontmatter,
        resolved: resolve(l.target, path, index),
      })),
    };
  }

  private context(text: string, scan: NoteScan, from: number, to: number): { line: number; context: string; contextRange: { from: number; to: number } } {
    const line = lineAt(scan.lineStarts, from);
    const start = scan.lineStarts[line];
    const end = line + 1 < scan.lineStarts.length ? scan.lineStarts[line + 1] - 1 : text.length;
    let lineText = text.slice(start, end).replace(/\r$/, '');
    let rFrom = from - start;
    let rTo = Math.min(to - start, lineText.length);
    if (lineText.length > 240) {
      const clipStart = Math.max(0, Math.min(rFrom - 100, lineText.length - 240));
      const clipped = lineText.slice(clipStart, clipStart + 240);
      const prefix = clipStart > 0 ? '…' : '';
      const suffix = clipStart + 240 < lineText.length ? '…' : '';
      lineText = prefix + clipped + suffix;
      rFrom = rFrom - clipStart + prefix.length;
      rTo = rTo - clipStart + prefix.length;
    }
    return { line, context: lineText, contextRange: { from: rFrom, to: rTo } };
  }

  getBacklinks(path: string, unlinked: boolean): BacklinksResponse {
    const target = this.existing(path);
    const index = this.linkIndex();
    const linked: Array<BacklinkGroup & { mtime: number }> = [];
    for (const note of this.indexed()) {
      const scan = this.scanOf(note);
      const text = this.indexTextOf(note);
      const mentions: Mention[] = [];
      for (const l of scan.links) {
        if (resolve(l.target, note.path, index) !== path || note.path === path) continue;
        mentions.push({ ...this.context(text, scan, l.from, l.to), from: l.from, to: l.to, matched: l.raw });
      }
      if (mentions.length) linked.push({ source: note.path, sourceVersion: blobId(note.bytes), mentions, mtime: note.mtime });
    }
    linked.sort((a, b) => b.mtime - a.mtime);
    let unlinkedGroups: BacklinkGroup[] | null = null;
    if (unlinked) {
      unlinkedGroups = [];
      if (kindOf(path) === 'note') {
        const names = [stripMd(lastSegment(path)), ...this.scanOf(target).aliases].filter((n) => n.length >= 3);
        const excluded = this.settings.files.excludedPaths.map((p) => p.toLowerCase());
        for (const note of this.notes()) {
          if (note.path === path || excluded.some((p) => note.path.toLowerCase().startsWith(p))) continue;
          const scan = this.scanOf(note);
          const text = this.textOf(note);
          const blocked: Array<[number, number]> = [...scan.excluded, ...scan.links.map((l) => [l.from, l.to] as [number, number])];
          const mentions: Mention[] = [];
          for (const name of names) {
            const re = new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu');
            for (const m of text.matchAll(re)) {
              const from = m.index;
              const to = from + m[0].length;
              if (blocked.some(([a, b]) => from < b && to > a)) continue;
              mentions.push({ ...this.context(text, scan, from, to), from, to, matched: m[0] });
            }
          }
          mentions.sort((a, b) => a.from - b.from);
          if (mentions.length) unlinkedGroups.push({ source: note.path, sourceVersion: blobId(note.bytes), mentions });
          if (unlinkedGroups.length >= 200) break;
        }
      }
    }
    return { path, linked: linked.map(({ mtime: _mtime, ...g }) => g), unlinked: unlinkedGroups };
  }

  resolveTargets(source: string, targets: string[]): Record<string, { path: string | null; createPath: string | null }> {
    if (targets.length === 0 || targets.length > 500) fail('bad-request', '1 to 500 targets', { errors: [] });
    const index = this.linkIndex();
    const out: Record<string, { path: string | null; createPath: string | null }> = {};
    for (const t of targets) {
      const path = resolve(t, source, index);
      out[t] = { path, createPath: path === null ? createPath(t, source, this.settings.files) : null };
    }
    return out;
  }

  // ---------- search and tags ----------

  search(q: string, limit = 50, sort: 'relevance' | 'mtime' = 'relevance', prefix = true): SearchResponse {
    const excluded = this.settings.files.excludedPaths.map((p) => p.toLowerCase());
    const docs: SearchDoc[] = this.indexed()
      .filter((note) => !excluded.some((p) => note.path.toLowerCase().startsWith(p)))
      .map((note) => ({
        path: note.path,
        text: this.indexTextOf(note),
        scan: this.scanOf(note),
        mtime: isoMs(note.mtime),
        ...(isCanvasPath(note.path) ? { title: basenameOf(note.path), kind: kindOf(note.path) } : {}),
      }));
    return mockSearch(docs, q, limit, sort, prefix);
  }

  // ---------- saved searches (API.md §12.4) ----------

  getSavedSearches(): SavedSearchesResponse {
    return { searches: structuredClone(this.savedSearches), version: this.savedSearchesVersion };
  }

  putSavedSearches(req: SavedSearchesUpdateRequest, origin: string): SavedSearchesResponse {
    const ids = new Set<string>();
    req.searches.forEach((s, i) => {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(s.id) || ids.has(s.id)) fail('bad-request', 'Invalid saved searches', { errors: [{ field: `searches[${i}].id`, message: 'invalid' }] });
      if (!s.name.trim() || !s.query.trim()) fail('bad-request', 'Invalid saved searches', { errors: [{ field: `searches[${i}].name`, message: 'required' }] });
      ids.add(s.id);
    });
    const version = blobId(encoder.encode(JSON.stringify(req.searches)));
    if (version === this.savedSearchesVersion) return this.getSavedSearches();
    if ((req.baseVersion || null) !== this.savedSearchesVersion) {
      fail('version-conflict', 'The saved searches changed on the server', {
        path: '.notesapp/searches.json',
        currentVersion: this.savedSearchesVersion,
        currentContent: JSON.stringify({ schemaVersion: 1, searches: this.savedSearches }),
        currentMtime: null,
        movedTo: null,
      });
    }
    this.savedSearches = structuredClone(req.searches);
    this.savedSearchesVersion = version;
    this.hub.publish('searches.changed', { version, origin }, origin);
    return this.getSavedSearches();
  }

  /** The link graph (API.md §11.4), built from scratch on every call; the version hashes it. */
  getGraph(since?: string): GraphResponse {
    const excluded = (p: string) => this.settings.files.excludedPaths.some((e) => {
      const prefix = e.replace(/\/+$/, '').toLowerCase();
      const lower = p.toLowerCase();
      return prefix !== '' && (lower === prefix || lower.startsWith(prefix + '/'));
    });
    const index = this.linkIndex();
    const paths = [...this.files.keys()].filter((p) => !excluded(p)).sort();
    const ids = new Map<string, number>();
    const nodes: GraphNode[] = [];
    for (const path of paths) {
      ids.set(path, nodes.length);
      const note = kindOf(path) === 'note';
      const tags = note ? [...new Set(this.scanOf(this.files.get(path)!).tags)].sort((a, b) => a.localeCompare(b)) : [];
      nodes.push({ path, type: note ? 'note' : 'attachment', tags });
    }
    const unresolved = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const path of paths) {
      if (kindOf(path) !== 'note') continue;
      const s = ids.get(path)!;
      for (const link of this.scanOf(this.files.get(path)!).links) {
        const resolved = resolve(link.target, path, index);
        let t: number | undefined;
        if (resolved !== null) {
          if (resolved === path) continue;
          t = ids.get(resolved);
        } else {
          const name = link.target.trim().replace(/\.md$/i, '').trim();
          if (!name) continue;
          t = unresolved.get(name.toLowerCase());
          if (t === undefined) {
            t = nodes.length;
            unresolved.set(name.toLowerCase(), t);
            nodes.push({ path: name, type: 'unresolved', tags: [] });
          }
        }
        if (t === undefined) continue;
        const key = `${s},${t}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const edges = [...counts]
      .map(([key, n]) => [...key.split(',').map(Number), n])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .flat();
    const version = blobId(new TextEncoder().encode(JSON.stringify([nodes, edges])));
    if (since === version) return { version, unchanged: true, nodes: [], edges: [] };
    return { version, unchanged: false, nodes, edges };
  }

  /** The compatibility report (API.md §11.5): the mock vault has no .obsidian/, only its links are checked. */
  getCompat(): CompatReport {
    const index = this.linkIndex();
    const notes: CompatOccurrence[] = [];
    const files: CompatOccurrence[] = [];
    const paths = { notes: new Set<string>(), files: new Set<string>() };
    for (const note of this.notes().sort((a, b) => (a.path < b.path ? -1 : 1))) {
      for (const link of this.scanOf(note).links) {
        if (resolve(link.target, note.path, index) !== null) continue;
        const kind = kindOf(link.target);
        const toFile = link.embed || (kind !== 'note' && kind !== 'other');
        (toFile ? files : notes).push({ path: note.path, line: link.line, text: link.raw });
        (toFile ? paths.files : paths.notes).add(note.path);
      }
    }
    const issue = (id: string, severity: CompatIssue['severity'], title: string, detail: string, list: CompatOccurrence[], count: number): CompatIssue => ({
      id,
      category: 'links',
      severity,
      title,
      detail,
      roadmapItem: null,
      count: list.length,
      noteCount: count,
      occurrences: list.slice(0, 200),
      truncated: list.length > 200,
    });
    const issues: CompatIssue[] = [];
    if (files.length) issues.push(issue('missing-files', 'warning', 'Embeds and file links that lead nowhere', 'The embedded note or the linked attachment is not in the vault.', files, paths.files.size));
    if (notes.length) issues.push(issue('missing-notes', 'info', 'Links to notes that do not exist yet', 'As in Obsidian, following such a link creates the note.', notes, paths.notes.size));
    return {
      generatedAt: new Date().toISOString(),
      tookMs: 1,
      obsidian: { found: false, configFiles: [], problems: [] },
      settings: [],
      proposedSettings: null,
      settingsVersion: this.settingsVersion,
      graph: null,
      plugins: [],
      issues,
      totals: { notes: this.notes().length, files: this.files.size, errors: 0, warnings: files.length, infos: notes.length },
    };
  }

  getTags(): TagCount[] {
    const exact = new Map<string, { display: string; notes: Set<string> }>();
    for (const note of this.indexed()) {
      for (const tag of this.scanOf(note).tags) {
        const key = tag.toLowerCase();
        const e = exact.get(key) ?? { display: tag, notes: new Set<string>() };
        e.notes.add(note.path);
        exact.set(key, e);
      }
    }
    const all = new Map<string, { display: string; count: number; notes: Set<string> }>();
    for (const [key, e] of exact) {
      const parts = key.split('/');
      const displayParts = e.display.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const k = parts.slice(0, i).join('/');
        const cur = all.get(k) ?? { display: displayParts.slice(0, i).join('/'), count: 0, notes: new Set<string>() };
        if (i === parts.length) cur.count = e.notes.size;
        for (const n of e.notes) cur.notes.add(n);
        all.set(k, cur);
      }
    }
    return [...all.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([, v]) => ({ tag: v.display, count: v.count, total: v.notes.size }));
  }

  // ---------- history ----------

  getHistory(path: string, limit = 50, offset = 0): HistoryResponse {
    const entries: HistoryEntry[] = [];
    let current = path;
    for (let i = this.commits.length - 1; i >= 0; i--) {
      const c = this.commits[i];
      const change = c.changes.find((x) => x.path === current);
      if (!change) continue;
      entries.push({
        commitId: c.commitId,
        shortId: c.commitId.slice(0, 7),
        parentCommitId: c.parentCommitId,
        path: current,
        time: isoMs(c.time),
        authorName: 'Owner',
        authorLogin: 'owner@notes',
        message: c.message,
        change: change.change,
        renamedFrom: change.renamedFrom,
      });
      if (change.renamedFrom) current = change.renamedFrom;
    }
    const size = this.files.get(path)?.bytes.length ?? 0;
    const excluded = size > LARGE_FILE_LIMIT ? { reason: 'large-file' as const, size, limitBytes: LARGE_FILE_LIMIT } : null;
    return { path, pending: false, hasMore: entries.length > offset + limit, entries: entries.slice(offset, offset + limit), excluded };
  }

  private bytesAt(path: string, commit: string): Uint8Array {
    const idx = this.commits.findIndex((c) => c.commitId === commit);
    if (idx < 0) fail('not-found', 'Unknown commit');
    for (let i = idx; i >= 0; i--) {
      const change = this.commits[i].changes.find((c) => c.path === path);
      if (!change) continue;
      if (change.bytes === null) break;
      return change.bytes;
    }
    return fail('not-found', 'The path is absent at that commit', { path });
  }

  getHistoryContent(path: string, commit: string): HistoryContent {
    const bytes = this.bytesAt(path, commit);
    const kind = kindOf(path);
    const text = kind === 'note' || kind === 'text';
    const decoded = text ? decodeText(bytes) : null;
    return { commitId: commit, path, version: blobId(bytes), size: bytes.length, binary: !text, content: decoded?.content ?? null, lossy: decoded?.lossy ?? false };
  }

  historyBytes(path: string, commit: string): Uint8Array | null {
    try {
      return this.bytesAt(path, commit);
    } catch {
      return null;
    }
  }

  restoreHistory(req: HistoryRestoreRequest, origin: string | null): HistoryRestoreResult {
    const bytes = this.bytesAt(req.sourcePath ?? req.path, req.commit);
    const existing = this.files.get(req.path);
    const kind = kindOf(req.path);
    const text = kind === 'note' || kind === 'text';
    if (text && existing) {
      if (req.baseVersion === null) fail('already-exists', 'The file exists', { path: req.path, existingPath: req.path });
      const current = blobId(existing.bytes);
      if (req.baseVersion !== current) {
        fail('version-conflict', 'File changed on the server', {
          path: req.path,
          currentVersion: current,
          currentContent: this.textOf(existing),
          currentMtime: isoMs(existing.mtime),
          movedTo: null,
        });
      }
    }
    const createdFolders = this.missingParents(req.path);
    const f = this.writeRaw(req.path, bytes);
    const file = this.entry(f);
    this.publishFolders(createdFolders, origin);
    this.hub.publish(existing ? 'file.changed' : 'file.created', { file, origin }, origin);
    const commitId = this.commit(`Restore ${req.path} to version ${req.commit.slice(0, 7)}`, [
      { path: req.path, change: existing ? 'modified' : 'added', renamedFrom: null },
    ])!;
    return { file, created: !existing, createdFolders, commitId };
  }

  // ---------- vault-wide history (API.md §14.6–14.8) ----------

  private inPeriod(c: Commit, f: TimelineFilter): boolean {
    return (!f.since || c.time >= Date.parse(f.since)) && (!f.until || c.time < Date.parse(f.until));
  }

  private underPath(path: string, prefix: string | undefined): boolean {
    return !prefix || path === prefix || path.startsWith(prefix + '/');
  }

  getHistoryLog(f: TimelineFilter, limit = 50, offset = 0): TimelineResponse {
    const author = f.author?.toLowerCase();
    const matching = [...this.commits]
      .reverse()
      .filter((c) => this.inPeriod(c, f) && (!author || 'owner'.includes(author) || 'owner@notes'.includes(author)))
      .filter((c) => !f.path || c.changes.some((x) => this.underPath(x.path, f.path) || (x.renamedFrom && this.underPath(x.renamedFrom, f.path))));
    const entries: TimelineEntry[] = matching.slice(offset, offset + limit).map((c) => {
      const files = c.changes
        .filter((x) => !f.path || this.underPath(x.path, f.path) || (x.renamedFrom !== null && this.underPath(x.renamedFrom, f.path)))
        .map((x) => ({ path: x.path, change: x.change, renamedFrom: x.renamedFrom }));
      return {
        commitId: c.commitId,
        shortId: c.commitId.slice(0, 7),
        parentCommitId: c.parentCommitId,
        time: isoMs(c.time),
        authorName: 'Owner',
        authorLogin: 'owner@notes',
        message: c.message,
        files: files.slice(0, 100),
        filesTotal: files.length,
      };
    });
    return { entries, hasMore: matching.length > offset + limit };
  }

  getHistoryChanges(f: TimelineFilter): ChangesResponse {
    const inRange = this.commits.filter((c) => this.inPeriod(c, f));
    const before = this.commits.filter((c) => f.since && c.time < Date.parse(f.since));
    const net = new Map<string, TimelineFile>();
    for (const c of inRange) {
      for (const x of c.changes) {
        if (!this.underPath(x.path, f.path)) continue;
        const prior = net.get(x.renamedFrom ?? x.path);
        if (x.renamedFrom) net.delete(x.renamedFrom);
        const change = prior?.change === 'added' && x.change !== 'deleted' ? 'added' : x.change;
        if (prior?.change === 'added' && x.change === 'deleted') net.delete(x.path);
        else net.set(x.path, { path: x.path, change, renamedFrom: x.renamedFrom ?? prior?.renamedFrom ?? null });
      }
    }
    return {
      since: f.since ?? null,
      until: f.until ?? null,
      fromCommitId: before.length ? before[before.length - 1].commitId : null,
      toCommitId: inRange.length ? inRange[inRange.length - 1].commitId : null,
      commits: inRange.length,
      authors: inRange.length ? ['Owner'] : [],
      files: [...net.values()].sort((a, b) => cmp(a.path.toLowerCase(), b.path.toLowerCase())),
      truncated: false,
    };
  }

  getDeletedFiles(q: string, limit = 50, offset = 0): DeletedFilesResponse {
    const latest = new Map<string, DeletedFile>();
    const decided = new Set<string>();
    for (let i = this.commits.length - 1; i >= 0; i--) {
      const c = this.commits[i];
      for (const x of c.changes) {
        if (x.renamedFrom) decided.add(x.renamedFrom);
        if (decided.has(x.path)) continue;
        decided.add(x.path);
        if (x.change === 'deleted' && c.parentCommitId && !this.files.has(x.path)) {
          latest.set(x.path, {
            path: x.path,
            deletedAt: isoMs(c.time),
            commitId: c.commitId,
            shortId: c.commitId.slice(0, 7),
            parentCommitId: c.parentCommitId,
            authorName: 'Owner',
            authorLogin: 'owner@notes',
            message: c.message,
          });
        }
      }
    }
    const all = [...latest.values()].filter((d) => !q || d.path.toLowerCase().includes(q.toLowerCase()));
    return { entries: all.slice(offset, offset + limit), total: all.length, hasMore: all.length > offset + limit };
  }

  commitNow(): CommitResult {
    return { commitId: null };
  }

  getTemplates(): TemplatesResponse {
    const folder = this.settings.templates.folder;
    const templates = [...this.files.keys()]
      .filter((p) => kindOf(p) === 'note' && (folder === '' || p.startsWith(folder + '/')))
      .sort()
      .map((path) => ({ path, name: stripMd(lastSegment(path)) }));
    return { folder, templates };
  }

  // ---------- simulated external activity (window.notesMock) ----------

  externalWrite(path: string, content: string, origin: string | null = null): void {
    const existed = this.files.has(path);
    const created = existed ? [] : this.missingParents(path);
    const f = this.writeRaw(path, encoder.encode(content));
    this.publishFolders(created, origin);
    this.hub.publish(existed ? 'file.changed' : 'file.created', { file: this.entry(f), origin }, origin);
    this.commit(origin === null ? 'External changes' : `Update ${path}`, [{ path, change: existed ? 'modified' : 'added', renamedFrom: null }]);
  }

  externalDelete(path: string): void {
    if (!this.files.delete(path)) return;
    this.hub.publish('file.deleted', { path, trashed: false, trashId: null, origin: null }, null);
    this.commit('External changes', [{ path, change: 'deleted', renamedFrom: null }]);
  }
}

/** Where a link's subpath (after its first `#`) is in the text, or null (API.md §22). */
export function headingSubpathSpan(text: string, link: { style: 'wiki' | 'markdown'; embed: boolean; raw: string; from: number; targetFrom: number; targetTo: number }): [number, number] | null {
  if (link.style === 'wiki') {
    const prefix = link.embed ? 3 : 2;
    const body = link.raw.slice(prefix, -2);
    const pipe = body.indexOf('|');
    const leftEnd = pipe < 0 ? body.length : pipe > 0 && body[pipe - 1] === '\\' ? pipe - 1 : pipe;
    const hash = body.indexOf('#');
    if (hash < 0 || hash >= leftEnd) return null;
    return [link.from + prefix + hash + 1, link.from + prefix + leftEnd];
  }
  // The mock's markdown target span is the whole destination, subpath included.
  const hash = text.slice(link.targetFrom, link.targetTo).indexOf('#');
  return hash < 0 ? null : [link.targetFrom + hash + 1, link.targetTo];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The 0-based line that ends with block id `id`. */
function lineOf(text: string, id: string): number {
  return noteLines(text).findIndex((l) => LINE_BLOCK_ID.exec(l)?.[1] === id);
}
