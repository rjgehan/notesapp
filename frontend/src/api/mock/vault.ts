// In-memory vault behind the dev mock. It follows the server's rules closely enough that the UI
// can be built and exercised without the backend: version protocol (API.md §4), name rules,
// case policy, trash, link rewriting on move, backlinks, search, tags, history and events.
import { flattenItems as flattenBookmarkItems, rekeyBookmarks } from '../../features/bookmarks';
import { buildLinkIndex, createPath, encodeMdPath, linkText, linkTextRaw, resolve, type LinkIndex } from '../../features/links';
import { extensionOf, folderOf, joinPath, lastSegment, basenameOf, newPathError, pathSafetyError, rebasePath, stripMd } from '../../features/paths';
import { splitWikiBody } from '../../features/syntax';
import { DEFAULT_SETTINGS } from '../../features/settings';
import type {
  AlertTestResult,
  AttachmentResult,
  BacklinkGroup,
  BacklinksResponse,
  BookmarkItem,
  BookmarksResponse,
  BookmarksUpdateRequest,
  ChangeType,
  CommitResult,
  CreateFileRequest,
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
  SearchHit,
  SearchResponse,
  Settings,
  SettingsResponse,
  SettingsUpdateRequest,
  StatusDetails,
  StatusResponse,
  TagCount,
  TemplatesResponse,
  TextFile,
  TrashEntry,
  TreeResponse,
  WriteResult,
} from '../types';
import { MockEventHub } from './events';
import { numbered, sanitizeAttachmentName } from './names';
import { fail } from './problems';
import { lineAt, scanNote, type NoteScan, type ScannedLink } from './scan';
import { seedFiles } from './seed';
import { blobId } from './sha1';

const TEXT_LIMIT = 5 * 1024 * 1024;
/** The server's default large-file threshold (DESIGN §5.8): larger files are kept out of history. */
const LARGE_FILE_LIMIT = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set('txt markdown json canvas excalidraw sheet tasks csv tsv yaml yml'.split(' '));
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

function foldAccents(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export class MockVault {
  readonly hub = new MockEventHub();
  private files = new Map<string, StoredFile>();
  private folders = new Set<string>();
  private trash: TrashItem[] = [];
  private commits: Commit[] = [];
  private scans = new Map<string, { version: string; scan: NoteScan }>();
  private moveLog = new Map<string, string>();
  private idempotency = new Map<string, unknown>();
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private settingsVersion = '';
  private bookmarks: BookmarkItem[] = [];
  private bookmarksVersion = blobId(encoder.encode(JSON.stringify([])));
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
    const version = blobId(f.bytes);
    const cached = this.scans.get(f.path);
    if (cached && cached.version === version) return cached.scan;
    const scan = scanNote(decodeText(f.bytes).content);
    this.scans.set(f.path, { version, scan });
    return scan;
  }

  private textOf(f: StoredFile): string {
    return decodeText(f.bytes).content;
  }

  private notes(): StoredFile[] {
    return [...this.files.values()].filter((f) => kindOf(f.path) === 'note');
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
    for (const note of this.notes()) {
      const scan = this.scanOf(note);
      const text = this.textOf(note);
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
    const started = performance.now();
    if (limit < 1 || limit > 200) fail('bad-request', 'limit out of range', { errors: [{ field: 'limit', message: '1 to 200' }] });
    const clauses = parseQuery(q);
    const positive = clauses.filter((c) => !c.negated);
    if (positive.length === 0) return { query: q, total: 0, tookMs: 0, results: [] };
    const lastWord = [...clauses].reverse().find((c) => c.kind === 'word' && !c.negated);
    const excluded = this.settings.files.excludedPaths.map((p) => p.toLowerCase());
    const hits: SearchHit[] = [];
    for (const note of this.notes()) {
      if (excluded.some((p) => note.path.toLowerCase().startsWith(p))) continue;
      const scan = this.scanOf(note);
      const text = this.textOf(note);
      const body = foldAccents(text);
      const title = stripMd(lastSegment(note.path));
      let ok = true;
      let score = 0;
      for (const c of clauses) {
        const isPrefix = prefix && c === lastWord && c.value.length >= 2;
        const matched = this.clauseMatches(c, note.path, title, body, scan, isPrefix);
        if (matched === c.negated) {
          ok = false;
          break;
        }
        if (!c.negated && (c.kind === 'word' || c.kind === 'phrase')) {
          const needle = foldAccents(c.value);
          score += (foldAccents(title).includes(needle) ? 4 : 0) + Math.min(5, body.split(needle).length - 1);
        }
      }
      if (!ok) continue;
      const terms = positive.filter((c) => c.kind === 'word' || c.kind === 'phrase').map((c) => foldAccents(c.value));
      const lines = text.split('\n');
      const matches: SearchHit['matches'] = [];
      let moreMatches = 0;
      for (let i = lineAt(scan.lineStarts, scan.bodyStart); i < lines.length && terms.length; i++) {
        const folded = foldAccents(lines[i]);
        const ranges = terms.flatMap((t) => {
          const at = folded.indexOf(t);
          return at >= 0 ? [{ from: at, to: at + t.length }] : [];
        });
        if (ranges.length === 0) continue;
        if (matches.length < 3) matches.push({ line: i, text: lines[i].replace(/\r$/, '').slice(0, 200), ranges: ranges.filter((r) => r.to <= 200) });
        else moreMatches++;
      }
      const titleRanges = terms.flatMap((t) => {
        const at = foldAccents(title).indexOf(t);
        return at >= 0 ? [{ from: at, to: at + t.length }] : [];
      });
      hits.push({ path: note.path, basename: title, score, mtime: isoMs(note.mtime), titleRanges, matches, moreMatches });
    }
    hits.sort((a, b) => (sort === 'mtime' ? 0 : b.score - a.score) || Date.parse(b.mtime) - Date.parse(a.mtime));
    return { query: q, total: hits.length, tookMs: Math.round(performance.now() - started), results: hits.slice(0, limit) };
  }

  private clauseMatches(c: QueryClause, path: string, title: string, body: string, scan: NoteScan, isPrefix: boolean): boolean {
    const v = foldAccents(c.value);
    switch (c.kind) {
      case 'tag': {
        const tag = v.replace(/^#/, '');
        return scan.tags.some((t) => {
          const lt = t.toLowerCase();
          return lt === tag || lt.startsWith(tag + '/');
        });
      }
      case 'path':
        return path.toLowerCase().includes(c.value.toLowerCase());
      case 'file':
        return lastSegment(path).toLowerCase().includes(c.value.toLowerCase());
      case 'phrase':
        return body.includes(v) || foldAccents(title).includes(v);
      case 'word': {
        const hay = `${foldAccents(title)} ${scan.aliases.map(foldAccents).join(' ')} ${body}`;
        if (isPrefix) return new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(hay);
        return new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(hay);
      }
    }
  }

  getTags(): TagCount[] {
    const exact = new Map<string, { display: string; notes: Set<string> }>();
    for (const note of this.notes()) {
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

// ---------- search query grammar (API.md §12.1) ----------

interface QueryClause {
  kind: 'word' | 'phrase' | 'tag' | 'path' | 'file';
  value: string;
  negated: boolean;
}

export function parseQuery(q: string): QueryClause[] {
  const out: QueryClause[] = [];
  let i = 0;
  const readValue = (): { value: string; phrase: boolean } => {
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const value = end < 0 ? q.slice(i + 1) : q.slice(i + 1, end);
      i = end < 0 ? q.length : end + 1;
      return { value, phrase: true };
    }
    const start = i;
    while (i < q.length && !/\s/.test(q[i]) && q[i] !== '"') i++;
    return { value: q.slice(start, i), phrase: false };
  };
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++;
    if (i >= q.length) break;
    let negated = false;
    if (q[i] === '-') {
      negated = true;
      i++;
    }
    const filter = /^(tag|path|file):/i.exec(q.slice(i));
    if (filter) {
      i += filter[0].length;
      const { value } = readValue();
      if (value) out.push({ kind: filter[1].toLowerCase() as 'tag' | 'path' | 'file', value, negated });
      continue;
    }
    const { value, phrase } = readValue();
    if (value) out.push({ kind: phrase ? 'phrase' : 'word', value, negated });
  }
  return out;
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
