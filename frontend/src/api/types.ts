// Generated from docs/API.md §17. Do not change without amending API.md.

export type VaultPath = string;   // vault-relative, '/'-separated, NFC; '' = root (folder contexts only)
export type Version = string;     // 40 lowercase hex: git blob id of the file bytes
export type IsoInstant = string;  // "2026-10-16T14:03:22.120Z"
export type EventId = string;     // "<bootId>.<seq>"

export type FileKind = 'note' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'other';
export type EntryType = 'file' | 'folder';
export type OnConflict = 'fail' | 'rename';
export type LinkStyle = 'wiki' | 'markdown';
export type ChangeType = 'added' | 'modified' | 'renamed' | 'deleted';

export interface TextRange { from: number; to: number }

// ---------- errors (§3) ----------
export type ErrorCode =
  | 'bad-request' | 'invalid-path' | 'invalid-name' | 'move-into-self'
  | 'client-id-required' | 'cross-origin' | 'identity-not-allowed' | 'reserved-path'
  | 'not-found' | 'method-not-allowed'
  | 'already-exists' | 'case-collision' | 'type-mismatch' | 'version-conflict' | 'settings-read-only'
  | 'too-large' | 'not-text' | 'unsupported-media-type' | 'unknown-host'
  | 'io-error' | 'permission-denied' | 'internal-error'
  | 'busy' | 'history-unavailable' | 'insufficient-storage';

export interface FieldError { field: string; message: string }

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  path?: VaultPath;
  existingPath?: VaultPath;
  expected?: 'file' | 'folder' | 'note';
  kind?: FileKind;
  limit?: number;
  from?: VaultPath;
  to?: VaultPath;
  reason?: string;
  incidentId?: string;
  errors?: FieldError[];
}

export interface VersionConflictProblem extends Problem {
  code: 'version-conflict';
  path: VaultPath;
  currentVersion: Version | null;
  currentContent: string | null;
  currentMtime: IsoInstant | null;
  movedTo: VaultPath | null;      // set when the file is gone because it was moved during this server run
}

// ---------- identity / status (§6) ----------
export interface MeResponse {
  login: string;
  name: string;
  profilePicUrl: string | null;
  source: 'tailscale' | 'default';
}

export interface SkippedEntry { name: string; reason: 'unsafe-name' | 'nfc-shadowed' }
export interface StatusResponse {
  appVersion: string;
  buildSha: string;
  bootId: string;
  startedAt: IsoInstant;
  eventId: EventId;
  vault: { notes: number; files: number; folders: number; bytes: number;
           skipped: SkippedEntry[]; unwritableDirs: VaultPath[] };
  index: { builtInMs: number; lastRescanAt: IsoInstant | null };
  git: { enabled: boolean; state: 'ready' | 'importing' | 'failing' | 'disabled'; reason: string | null;
         head: string | null; pendingPaths: number; nextCommitAt: IsoInstant | null;
         lastCommitAt: IsoInstant | null; lastError: string | null; failingSince: IsoInstant | null;
         largeFiles: { limitBytes: number | null; files: number; bytes: number } };   // kept out of history (§14.1)
  watcher: { mode: 'inotify' | 'polling' | 'disabled' };
  disk: { freeBytes: number; repoBytes: number | null };
  settings: { readOnly: boolean; reason: string | null };
  mirror: MirrorStatus;
}

export interface MirrorStatus {
  state: 'disabled' | 'ready' | 'failing' | 'diverged';
  reason: string | null;          // why it is disabled: "not configured", "history is disabled" or a configuration error
  remote: string | null;          // the mirror's URL; never contains credentials
  branch: string | null;          // the branch pushed, e.g. "main"
  pushing: boolean;
  pushedCommit: string | null;    // the last commit the mirror is known to have (this server run)
  lastPushAt: IsoInstant | null;  // the last successful push (this server run)
  nextPushAt: IsoInstant | null;  // null when up to date, disabled or diverged
  lastError: string | null;
  failingSince: IsoInstant | null;
}

// ---------- status page (§6.5) ----------
export interface StatusDetails {
  runtime: { javaVersion: string; javaVendor: string; aotCache: 'in-use' | 'not-used' | 'off' | 'unknown';
             heapUsedBytes: number; heapMaxBytes: number; processors: number };
  events: { clients: number };    // open live-sync (SSE) connections: browser tabs and app windows
  git: { commits: number | null;  // in the history; null when history is off
         commitsThisRun: number; failedCommitsThisRun: number;
         largeFiles: Array<{ path: VaultPath; bytes: number }>;   // kept out of history, largest first, at most 100
         largeFilesTruncated: boolean };
  disk: { totalBytes: number | null };
  backup: BackupStatus;
  alerts: AlertsStatus;
}

export interface BackupStatus {
  state: 'unknown' | 'ok' | 'failed' | 'stale';
  reason: string | null;          // why it is unknown
  lastRun: IsoInstant | null;
  lastSuccess: IsoInstant | null;
  snapshot: string | null;        // the restic snapshot id of the last run
  offsite: string | null;         // 'ok', 'off' or 'failed'
  failures: string | null;        // the failed steps of the last run
}

export interface AlertsStatus {
  state: 'off' | 'on' | 'error';
  reason: string | null;          // why it is off, or what is wrong with ntfy.json
  server: string | null;          // the ntfy server; never the topic or the token
  sent: number;                   // this server run
  dropped: number;                // held back by the rate limit, this server run
  lastSentAt: IsoInstant | null;
  lastError: string | null;
  lastErrorAt: IsoInstant | null;
  recent: Array<{ marker: string; count: number; lastAt: IsoInstant }>;   // logged since the server started
}

export interface AlertTestResult { sent: boolean; error: string | null }   // POST /api/alerts/test (§6.6)

// ---------- settings (§5) ----------
export interface FilesSettings {
  newNoteLocation: 'root' | 'current' | 'folder';
  newNoteFolder: VaultPath;
  newLinkFormat: 'shortest' | 'relative' | 'absolute';
  useWikilinks: boolean;
  attachmentLocation: 'root' | 'folder' | 'current' | 'subfolder';
  attachmentFolder: VaultPath;
  attachmentSubfolder: string;
  autoUpdateLinks: boolean;
  excludedPaths: VaultPath[];
}
export interface DailyNotesSettings { format: string; folder: VaultPath; template: VaultPath; openOnStartup: boolean }
export interface TemplatesSettings { folder: VaultPath; dateFormat: string; timeFormat: string }
export interface EditorSettings { defaultMode: 'edit' | 'read'; readableLineLength: boolean; strictLineBreaks: boolean }
export interface Settings {
  schemaVersion: 1;
  files: FilesSettings;
  dailyNotes: DailyNotesSettings;
  templates: TemplatesSettings;
  editor: EditorSettings;
}
export interface SettingsResponse { settings: Settings; version: Version; readOnly: boolean }
export interface SettingsUpdateRequest { settings: Settings; baseVersion: Version }

// ---------- tree (§7) ----------
export interface FileEntry {
  path: VaultPath;
  name: string;
  basename: string;
  extension: string;
  kind: FileKind;
  size: number;
  mtime: IsoInstant;
  version: Version | null;
  aliases: string[];
}
export interface FolderEntry { path: VaultPath; name: string }
export interface TreeResponse { eventId: EventId; folders: FolderEntry[]; files: FileEntry[] }

// ---------- text files (§8) ----------
export interface TextFile {
  path: VaultPath;
  kind: 'note' | 'text';
  content: string;
  version: Version;
  size: number;
  mtime: IsoInstant;
  lossy: boolean;
}
export interface CreateFileRequest { path: VaultPath; content?: string; onConflict?: OnConflict }
export interface SaveFileRequest { content: string; baseVersion: Version | null; flushHistory?: boolean }
export interface WriteResult { file: FileEntry; created: boolean; createdFolders: VaultPath[] }

// ---------- attachments (§9.3) ----------
export interface AttachmentResult {
  file: FileEntry;
  created: boolean;
  createdFolders: VaultPath[];
  linkText: string;
  markdown: string;
}

// ---------- folders / move (§10) ----------
export interface CreateFolderRequest { path: VaultPath }
export interface FolderResult { folder: FolderEntry; createdFolders: VaultPath[] }
export interface MoveRequest { from: VaultPath; to: VaultPath; updateLinks?: boolean; dryRun?: boolean }
export interface MovedFile { from: VaultPath; to: VaultPath }
export interface LinkUpdate { path: VaultPath; links: number; version: Version | null }
export type FailedReason = 'not-utf8' | 'not-rewritable' | 'span-mismatch' | 'io-error';
export interface FailedUpdate { path: VaultPath; reason: FailedReason }
export interface MoveResult {
  dryRun: boolean;
  type: EntryType;
  from: VaultPath;
  to: VaultPath;
  moved: MovedFile[];
  createdFolders: VaultPath[];
  linkUpdates: LinkUpdate[];
  failed: FailedUpdate[];
  commitId: string | null;        // the last commit made; null for a dry run, disabled git, nothing to commit, or a failed commit
}

// ---------- notes / links (§11) ----------
export interface HeadingInfo { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; line: number }
export interface OutgoingLink {
  raw: string;
  target: string;
  subpath: string | null;
  display: string | null;
  embed: boolean;
  style: LinkStyle;
  line: number;
  from: number;
  to: number;
  inFrontmatter: boolean;
  resolved: VaultPath | null;
}
export interface NoteMeta {
  path: VaultPath;
  version: Version;
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  aliases: string[];
  tags: string[];
  headings: HeadingInfo[];
  blockIds: string[];
  links: OutgoingLink[];
}
export interface Mention {
  line: number;
  from: number;
  to: number;
  matched: string;
  context: string;
  contextRange: TextRange;
}
export interface BacklinkGroup { source: VaultPath; sourceVersion: Version; mentions: Mention[] }
export interface BacklinksResponse { path: VaultPath; linked: BacklinkGroup[]; unlinked: BacklinkGroup[] | null }
export interface ResolveRequest { source: VaultPath; targets: string[] }
export interface ResolvedLink { path: VaultPath | null; createPath: VaultPath | null }
export interface ResolveResponse { resolved: Record<string, ResolvedLink> }

// ---------- graph (§11.4) ----------
export type GraphNodeType = 'note' | 'attachment' | 'unresolved';
export interface GraphNode {
  path: VaultPath;   // the file; for 'unresolved', the link target as first written, without '.md'
  type: GraphNodeType;
  tags: string[];    // notes only: display casing, without '#', sorted case-insensitively
}
export interface GraphResponse {
  version: string;     // opaque; changes when a node, an edge or a note's tags change
  unchanged: boolean;  // `since` equals `version`: nodes and edges are empty, keep the graph you have
  nodes: GraphNode[];
  edges: number[];     // flat triples [source, target, count, ...]: node indexes, links from source to target
}

// ---------- search / tags (§12) ----------
export interface SearchMatch { line: number; text: string; ranges: TextRange[] }
export interface SearchHit {
  path: VaultPath;
  basename: string;
  score: number;
  mtime: IsoInstant;
  titleRanges: TextRange[];
  matches: SearchMatch[];
  moreMatches: number;
}
export interface SearchResponse { query: string; total: number; tookMs: number; results: SearchHit[] }
export interface TagCount { tag: string; count: number; total: number }
export interface TagsResponse { tags: TagCount[] }

// ---------- trash (§13) ----------
export interface TrashEntry {
  id: string;
  originalPath: VaultPath;
  type: EntryType;
  deletedAt: IsoInstant;
  deletedBy: string;
  size: number;
  fileCount: number;
}
export interface TrashListResponse { entries: TrashEntry[] }
export interface RestoreRequest { to?: VaultPath; onConflict?: OnConflict }
export interface RestoreResult {
  type: EntryType;
  path: VaultPath;
  files: FileEntry[];
  createdFolders: VaultPath[];
  commitId: string | null;
}
export interface PurgeResult { purged: number }

// ---------- history (§14) ----------
export interface HistoryEntry {
  commitId: string;
  shortId: string;
  parentCommitId: string | null;  // read a 'deleted' entry's content from here
  path: VaultPath;
  time: IsoInstant;
  authorName: string;
  authorLogin: string;
  message: string;
  change: ChangeType;
  renamedFrom: VaultPath | null;
}
export interface HistoryResponse {
  path: VaultPath;
  pending: boolean;
  hasMore: boolean;
  entries: HistoryEntry[];
  excluded: HistoryExclusion | null;  // set when new versions of the file are not kept in history
}
export interface HistoryExclusion { reason: 'large-file'; size: number; limitBytes: number }
export interface HistoryContent {
  commitId: string;
  path: VaultPath;
  version: Version;
  size: number;
  binary: boolean;
  content: string | null;
  lossy: boolean;
}
export interface HistoryRestoreRequest { path: VaultPath; commit: string; sourcePath?: VaultPath; baseVersion: Version | null }
export interface HistoryRestoreResult { file: FileEntry; created: boolean; createdFolders: VaultPath[]; commitId: string | null }
export interface CommitResult { commitId: string | null }

// ---------- templates (§15.4) ----------
export interface TemplateEntry { path: VaultPath; name: string }
export interface TemplatesResponse { folder: VaultPath; templates: TemplateEntry[] }

// ---------- SSE (§16) ----------
export interface HelloEvent {
  bootId: string;
  eventId: EventId;               // current head
  resync: boolean;
  replayed: number;               // replayed events that follow this hello; 0 when resync is true
  buildSha: string;               // running server build; compare with the page's own build
  serverTime: IsoInstant;
}
export interface PingEvent { serverTime: IsoInstant }   // heartbeat; sent without an id, never replayed
export interface FileEvent { file: FileEntry; origin: string | null }
export interface FileDeletedEvent { path: VaultPath; trashed: boolean; trashId: string | null; origin: string | null }
export interface FolderEvent { path: VaultPath; origin: string | null }
export interface FolderDeletedEvent { path: VaultPath; trashed: boolean; trashId: string | null; origin: string | null }
export interface MovedEvent { from: VaultPath; to: VaultPath; type: EntryType; origin: string | null }
export type TrashChangedEvent = Record<string, never>;
export interface HistoryCommittedEvent {
  commitId: string;
  message: string;
  authorName: string;
  time: IsoInstant;
  paths: VaultPath[];
  truncated: boolean;
}
export interface SettingsChangedEvent { version: Version; origin: string | null }
export interface StatusChangedEvent { reason: 'git' | 'watcher' | 'settings' | 'disk' | 'mirror' }
export interface ResyncEvent { reason: 'watcher-overflow' | 'bulk-change' | 'rescan-error' }

export interface VaultEventMap {
  'hello': HelloEvent;
  'ping': PingEvent;
  'file.created': FileEvent;
  'file.changed': FileEvent;
  'file.deleted': FileDeletedEvent;
  'folder.created': FolderEvent;
  'folder.deleted': FolderDeletedEvent;
  'entry.moved': MovedEvent;
  'trash.changed': TrashChangedEvent;
  'history.committed': HistoryCommittedEvent;
  'settings.changed': SettingsChangedEvent;
  'status.changed': StatusChangedEvent;
  'resync': ResyncEvent;
}
export type VaultEventName = keyof VaultEventMap;
export const VAULT_EVENT_NAMES: readonly VaultEventName[] = [
  'hello', 'ping', 'file.created', 'file.changed', 'file.deleted', 'folder.created', 'folder.deleted',
  'entry.moved', 'trash.changed', 'history.committed', 'settings.changed', 'status.changed', 'resync',
];
// Extensions add their own event names at runtime with registerEventHandler (DESIGN §6.8).
