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
  | 'task-conflict' | 'malformed-file'
  | 'too-large' | 'not-text' | 'unsupported-media-type' | 'unknown-host'
  | 'io-error' | 'permission-denied' | 'internal-error'
  | 'busy' | 'history-unavailable' | 'insufficient-storage'
  | 'not-audio' | 'transcription-off' | 'transcription-failed'
  | 'ai-unavailable' | 'ai-excluded' | 'ai-budget-exceeded'
  | 'block-not-found' | 'funnel-request' | 'publishing-off'
  | 'vault-not-found' | 'vault-unavailable' | 'vaults-off';

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
  spent?: number;                 // ai-budget-exceeded: this month's estimated spend in USD
  line?: number;                  // block-not-found: the line the request named (§37)
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

export interface TaskConflictProblem extends Problem {
  code: 'task-conflict';
  task?: Task;                    // the task as it is on the server (PATCH /api/tasks/{id})
  list?: TaskList;                // the list as it is on the server (PATCH /api/tasks/lists/{id})
  fields: string[];               // the requested fields that were changed on the server since the client read them
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
/** A folder template (ROADMAP item 30): new notes in `folder` (`""`: anywhere) start from `template`. */
export interface FolderTemplate { folder: VaultPath; template: VaultPath }
export interface TemplatesSettings { folder: VaultPath; dateFormat: string; timeFormat: string; folderTemplates: FolderTemplate[] }
export interface EditorSettings { defaultMode: 'edit' | 'read'; readableLineLength: boolean; strictLineBreaks: boolean }
/** Ask your vault and summaries (§24). Optional in a request: a body without it keeps the current values. */
export interface AiSettings {
  enabled: boolean;               // off by default: nothing is sent to Anthropic until this is on
  provider: AiProvider;           // 'claude-code' (default): the CLI with your Claude subscription; 'api': billed per token
  model: AiModelId;               // 'claude-sonnet-5-5' (default), 'claude-opus-5-5' or 'claude-haiku-5-5'
  excludedPaths: VaultPath[];     // never sent; files.excludedPaths are never sent either. Default ['Private']
  maxContextChars: number;        // note text one request may carry, 4,000 to 400,000; default 60,000
  monthlyBudgetUsd: number;       // requests are refused once this month's estimated spend reaches it; default 5
}
/** Reminders and push notifications (§28). Every route is off by default. Optional in a request, like ai. */
export interface RemindersSettings {
  webPush: boolean;               // Web Push to the devices subscribed in Settings › Reminders
  ntfy: boolean;                  // ntfy, configured in /data/secrets/ntfy.json
  ntfyTitleOnly: boolean;         // with ntfy, the task's title only, never its notes; default true
  inApp: boolean;                 // a toast and a browser notification in every open tab
  dailyNote: boolean;             // nudge when today's daily note does not exist yet
  dailyNoteTime: string;          // 'HH:mm', default '09:00'
}
export interface Settings {
  schemaVersion: 1;
  files: FilesSettings;
  dailyNotes: DailyNotesSettings;
  templates: TemplatesSettings;
  editor: EditorSettings;
  ai: AiSettings;
  reminders: RemindersSettings;
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

// ---------- quick capture (§8.5, §8.6) ----------
export type CaptureTarget = 'inbox' | 'daily';
export interface CaptureRequest {
  text?: string | null;
  target?: CaptureTarget;         // default 'inbox'
  url?: string | null;            // a shared link (http/https becomes a Markdown link)
  title?: string | null;          // the link's label
  date?: string;                  // YYYY-MM-DD, the device's day
  time?: string;                  // HH:mm, the device's time
  tz?: string;                    // IANA zone, used for what date/time leave out
}
export interface CaptureResult {
  file: FileEntry;                // the note the entry was appended to
  created: boolean;               // the capture created the note (201)
  createdFolders: VaultPath[];
  target: CaptureTarget;
  attachment: FileEntry | null;   // POST /api/capture/file only
}

// ---------- folders / move (§10) ----------
export interface CreateFolderRequest { path: VaultPath }
export interface FolderResult { folder: FolderEntry; createdFolders: VaultPath[] }
export interface MoveRequest { from: VaultPath; to: VaultPath; updateLinks?: boolean; dryRun?: boolean }
export interface MovedFile { from: VaultPath; to: VaultPath }
export interface LinkUpdate { path: VaultPath; links: number; version: Version | null }
export type FailedReason = 'not-utf8' | 'not-rewritable' | 'span-mismatch' | 'io-error' | 'property-exists';
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
export interface HeadingRenameRequest { path: VaultPath; from: string; to: string; dryRun?: boolean }   // §22
export interface HeadingRenameResult {
  dryRun: boolean;
  path: VaultPath;
  from: string;
  to: string;
  linkUpdates: LinkUpdate[];      // notes whose links were (or, in a dry run, would be) updated; version null in a dry run
  failed: FailedUpdate[];
  bookmarks: number;              // heading bookmarks of the note that were (or would be) updated
  commitId: string | null;
}
export interface BlockIdRequest {   // §37
  path: VaultPath;
  line: number;                   // 0-based line the client read lineText on (the block's anchor)
  lineText: string;
  placement: 'end' | 'after';     // append ' ^id' to the line, or put '^id' on a line of its own after it
  id?: string;                    // the id the client would like; another one is chosen when a block has it
}
export interface BlockIdResult {
  id: string;                     // the block's id: the new one, or the one it already had (created: false)
  created: boolean;
  line: number;                   // 0-based line that holds the id
  file: FileEntry;                // the note after the call
}

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

// ---------- compatibility report (§11.5) ----------
export interface ObsidianInfo { found: boolean; configFiles: string[]; problems: string[] }
export interface CompatSetting {
  source: string;               // 'app.json › attachmentFolderPath'
  obsidianValue: string;        // the value as JSON text
  setting: string | null;       // 'files.attachmentLocation'; null when NotesApp has none
  current: string | null;
  proposed: string | null;
  status: 'same' | 'different' | 'unsupported';
  note: string | null;
}
export interface CompatPlugin {
  id: string;
  name: string;
  kind: 'core' | 'community';
  status: 'supported' | 'partial' | 'planned' | 'unsupported' | 'unknown';
  note: string;
  roadmapItem: number | null;
}
export interface CompatOccurrence { path: VaultPath; line: number | null; text: string }
export interface CompatIssue {
  id: string;                   // 'dataview', 'missing-notes', …
  category: 'syntax' | 'links' | 'files';
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  roadmapItem: number | null;
  count: number;
  noteCount: number;
  occurrences: CompatOccurrence[];   // at most 200, in path order
  truncated: boolean;
}
export interface CompatTotals { notes: number; files: number; errors: number; warnings: number; infos: number }
export interface CompatReport {
  generatedAt: IsoInstant;
  tookMs: number;
  obsidian: ObsidianInfo;
  settings: CompatSetting[];
  proposedSettings: Settings | null;   // PUT /api/settings with baseVersion: settingsVersion to apply
  settingsVersion: Version;
  graph: Record<string, unknown> | null;   // .obsidian/graph.json, only the keys the graph view uses
  plugins: CompatPlugin[];
  issues: CompatIssue[];
  totals: CompatTotals;
}

// ---------- search / tags (§12) ----------
export interface SearchMatch {
  line: number;
  text: string;
  ranges: TextRange[];
  page: number | null;            // 1-based page of a PDF match; null otherwise
}
export interface SearchHit {
  path: VaultPath;
  basename: string;
  kind: FileKind;                 // 'note', or 'pdf' for a PDF's extracted text
  score: number;
  mtime: IsoInstant;
  titleRanges: TextRange[];
  matches: SearchMatch[];
  moreMatches: number;
}
export interface SearchCorrection { term: string; replacements: string[] }   // typo tolerance (§12.1)
export interface SearchResponse {
  query: string;
  total: number;
  tookMs: number;
  results: SearchHit[];
  corrections: SearchCorrection[];
}
export type SearchSort = 'relevance' | 'mtime';
export interface SavedSearch { id: string; name: string; query: string; sort: SearchSort }
export interface SavedSearchesResponse { searches: SavedSearch[]; version: Version | null }
export interface SavedSearchesUpdateRequest { searches: SavedSearch[]; baseVersion: Version | null }
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

// ---------- vault-wide history (§14.6–14.8) ----------
export interface TimelineFile { path: VaultPath; change: ChangeType; renamedFrom: VaultPath | null }
export interface TimelineEntry {
  commitId: string;
  shortId: string;
  parentCommitId: string | null;
  time: IsoInstant;
  authorName: string;
  authorLogin: string;
  message: string;
  files: TimelineFile[];          // at most 100; hidden paths (.notesapp/…) left out
  filesTotal: number;
}
export interface TimelineResponse { entries: TimelineEntry[]; hasMore: boolean }
export interface ChangesResponse {
  since: IsoInstant | null;
  until: IsoInstant | null;
  fromCommitId: string | null;    // the last commit before since; null = the beginning
  toCommitId: string | null;      // the last commit before until; null = no commits
  commits: number;
  authors: string[];
  files: TimelineFile[];          // net change from fromCommitId to toCommitId, at most 1000
  truncated: boolean;
}
export interface DeletedFile {
  path: VaultPath;
  deletedAt: IsoInstant;
  commitId: string;
  shortId: string;
  parentCommitId: string;         // its last content; restore with POST /api/history/restore
  authorName: string;
  authorLogin: string;
  message: string;
}
export interface DeletedFilesResponse { entries: DeletedFile[]; total: number; hasMore: boolean }

// ---------- templates (§15.4) ----------
export interface TemplateEntry { path: VaultPath; name: string }
export interface TemplatesResponse { folder: VaultPath; templates: TemplateEntry[] }

// ---------- bookmarks (§21) ----------
/**
 * One bookmark, in Obsidian's bookmarks.json format: `type` is 'file' (a note or any file; with `subpath`
 * '#Heading' or '#^blockid' for part of a note), 'folder', 'search' or 'group'. Other types Obsidian writes
 * ('url', 'graph') pass through unchanged. Fields that do not apply are absent rather than null, and fields this
 * build does not know are kept.
 */
export interface BookmarkItem {
  type: string;
  ctime?: number;                 // when it was bookmarked, epoch milliseconds
  title?: string;                 // a display name; groups show theirs
  path?: VaultPath;               // file and folder
  subpath?: string;               // file: '#Heading' or '#^blockid'
  query?: string;                 // search
  items?: BookmarkItem[];         // group
  [field: string]: unknown;
}
export interface BookmarksResponse { version: Version; items: BookmarkItem[] }
export interface BookmarksUpdateRequest { items: BookmarkItem[]; baseVersion: Version }

// ---------- voice notes (§23) ----------
export interface TranscriptionStatus {
  enabled: boolean;
  service: string | null;   // "whisper-asr at http://notesapp-whisper:9000"; never credentials
  language: string | null;  // the configured language; null = detected per recording
  maxBytes: number;         // larger recordings are not sent
}
export interface TranscriptionResult {
  path: VaultPath;
  text: string;             // "" when no speech was recognized
  language: string | null;
  millis: number;           // the service's time; 0 for a transcript the server had kept
}

// ---------- Ask your vault and summaries (§24) ----------
export type AiModelId = string;
export type AiProvider = 'claude-code' | 'api';
export type AiAction = 'ask' | 'summarize' | 'suggest';
export type AiScope = 'note' | 'folder' | 'notes' | 'selection';
/** What a turn asked: a question, or the fields of a summary request. */
export interface AiPrompt {
  action: AiAction;
  question?: string | null;       // ask
  scope?: AiScope | null;         // summarize, suggest
  path?: VaultPath | null;
  paths?: VaultPath[] | null;
  text?: string | null;
  label?: string | null;
}
/** An earlier turn of the conversation, as this device keeps it. */
export interface AiTurn { prompt: AiPrompt; answer: string; sources: VaultPath[] }
export interface AiAskRequest {
  question: string;               // 1 to 4,000 characters
  activePath?: VaultPath | null;  // the open note: sent first when it is not excluded
  history?: AiTurn[];             // oldest first, at most 50; the last 12 are used
}
export interface AiSummarizeRequest {
  action?: 'summarize' | 'suggest';   // suggest: links, tags and tasks for a note
  scope: AiScope;
  path?: VaultPath | null;        // the note, the folder, or the note a selection comes from
  paths?: VaultPath[];            // scope 'notes', at most 100
  text?: string | null;           // scope 'selection', at most 200,000 characters
  label?: string | null;          // what 'notes' are, e.g. "this week's daily notes"
  history?: AiTurn[];
}
export interface AiModelInfo { id: AiModelId; label: string; inputUsdPerMTok: number; outputUsdPerMTok: number }
export interface AiStatus {
  state: 'off' | 'not-configured' | 'over-budget' | 'ready';
  reason: string | null;
  provider: AiProvider;
  model: AiModelId;
  models: AiModelInfo[];
  keyFile: string;                // the provider's credential file (claude-token or anthropic-key), never its content
  keyPresent: boolean;
  cliInstalled: boolean;          // the Claude Code CLI is on the server
  month: string;                  // "2026-10", in the server's time zone
  monthCostUsd: number;           // estimated
  monthRequests: number;
  monthlyBudgetUsd: number;
  maxContextChars: number;
  fake: boolean;                  // a development server that answers without Anthropic
}
export interface AiSource { path: VaultPath; chars: number; truncated: boolean }
/** Events of the answer stream (`text/event-stream` on POST /api/ai/ask and /api/ai/summarize). */
export interface AiStartEvent { model: AiModelId; sources: AiSource[]; omitted: number; excluded: number }
export interface AiDeltaEvent { text: string }
export interface AiRestartEvent { model: AiModelId }   // a fallback model answers from the start
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
export interface AiDoneEvent {
  model: AiModelId;
  stopReason: string;             // 'end_turn', 'max_tokens', 'refusal', ...
  refusalCategory: string | null;
  fellBack: boolean;
  usage: AiUsage;
  costUsd: number;                // estimated, this request
  monthCostUsd: number;           // estimated, this month so far
}
export interface AiErrorEvent {
  code: 'auth' | 'rate-limited' | 'overloaded' | 'bad-request' | 'unavailable' | 'busy' | 'internal-error';
  message: string;
}
export interface AiStreamEventMap {
  start: AiStartEvent;
  delta: AiDeltaEvent;
  restart: AiRestartEvent;
  done: AiDoneEvent;
  error: AiErrorEvent;
}

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
export interface BookmarksChangedEvent { version: Version; origin: string | null }   // origin null: re-keyed by the server after a move or restore
export interface StatusChangedEvent { reason: 'git' | 'watcher' | 'settings' | 'disk' | 'mirror' }
export interface ResyncEvent { reason: 'watcher-overflow' | 'bulk-change' | 'rescan-error' }
export interface SavedSearchesChangedEvent { version: Version; origin: string | null }

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
  'bookmarks.changed': BookmarksChangedEvent;
  'status.changed': StatusChangedEvent;
  'resync': ResyncEvent;
  'searches.changed': SavedSearchesChangedEvent;
  'types.changed': PropertyTypesChangedEvent;
}
export type VaultEventName = keyof VaultEventMap;
export const VAULT_EVENT_NAMES: readonly VaultEventName[] = [
  'hello', 'ping', 'file.created', 'file.changed', 'file.deleted', 'folder.created', 'folder.deleted',
  'entry.moved', 'trash.changed', 'history.committed', 'settings.changed', 'bookmarks.changed', 'status.changed',
  'resync', 'searches.changed', 'types.changed',
];
// Extensions add their own event names at runtime with registerEventHandler (DESIGN §6.8).

// ---------- tasks (§20) ----------
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type TaskPriority = 0 | 1 | 2 | 3;              // none / low / medium / high
export type TaskView = 'today' | 'upcoming' | 'list' | 'completed' | 'search';
export type LocalDate = string;                       // 'YYYY-MM-DD' in the user's own time zone
export type LocalDateTime = string;                   // 'YYYY-MM-DDTHH:mm' in the user's own time zone
export type TaskDate = LocalDate | LocalDateTime;
export type OrderKey = string;                        // fractional index (§20.1)

export interface TaskRecurrence { rrule: string; from: 'due' | 'completion' }   // RFC 5545 RRULE subset (§20.6)
export interface TaskReminder { at: LocalDateTime }
export interface TaskSection { id: string; name: string; order: OrderKey }
export interface TaskList {
  id: string;
  name: string;
  color: string | null;           // '#rrggbb' or a color name such as 'green'
  icon: string | null;            // a lucide icon name such as 'shopping-cart'
  order: OrderKey;
  archived: boolean;              // left out of Today, Upcoming and the all-lists view
  sections: TaskSection[];        // in order
  path: VaultPath;                // the list's .tasks file
  writable: boolean;              // false: written by a newer NotesApp, so this version only reads it
}
export interface Task {
  id: string;
  listId: string;
  sectionId: string | null;
  parentId: string | null;        // subtasks, at most 3 levels
  title: string;                  // one line; [[Note]] links and #tags allowed inline
  notes: string | null;           // Markdown
  status: TaskStatus;
  priority: TaskPriority;
  due: TaskDate | null;
  start: TaskDate | null;         // the "do on" date; drives Today
  recurrence: TaskRecurrence | null;
  reminders: TaskReminder[];      // stored and validated; delivered by ROADMAP item 9
  tags: string[];                 // without '#'
  links: VaultPath[];             // related notes
  order: OrderKey;
  createdAt: IsoInstant | null;   // null only for a task added by hand without it
  updatedAt: IsoInstant | null;
  completedAt: IsoInstant | null;
  archived: boolean;              // closed and rolled into an archive file (Tasks/Archive/...)
}
export interface TaskFileProblem { path: VaultPath; taskId: string | null; reason: string }
export interface TasksResponse {
  view: TaskView;
  lists: TaskList[];              // every usable list, in order, archived ones included
  tasks: Task[];
  total: number;                  // matching tasks; tasks holds at most `limit` for completed and search
  problems: TaskFileProblem[];
}
export interface TaskListsResponse { lists: TaskList[]; problems: TaskFileProblem[] }

export interface TaskFields {     // what a client sets; null clears an optional field
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due?: TaskDate | null;
  start?: TaskDate | null;
  recurrence?: TaskRecurrence | null;
  reminders?: TaskReminder[];
  tags?: string[];
  links?: VaultPath[];
  listId?: string;
  sectionId?: string | null;
  parentId?: string | null;
}
export interface CreateTaskRequest extends TaskFields { title: string; after?: string | null }
export interface UpdateTaskRequest { changes: TaskFields; base?: TaskFields }
export interface CompleteTaskRequest {
  tz?: string;                    // the client's IANA time zone, or
  date?: LocalDate;               // the client's date: the completion day for recurrence
  base?: { due?: TaskDate | null; start?: TaskDate | null };
}
export interface ReorderTasksRequest {
  listId: string;
  sectionId: string | null;       // top-level tasks only
  parentId: string | null;
  ids: string[];
  after: string | null;           // null: first
}
export interface TaskWriteResult {
  task: Task | null;              // the addressed task after the change; null for reorder and delete
  changed: Task[];                // other tasks the change touched
  deleted: string[];              // ids removed: the task and its subtasks
  rolledForward: boolean;         // complete: a recurring task moved to its next occurrence
  files: FileEntry[];             // list files written; apply them like file.changed / file.created
  createdFolders: VaultPath[];
  lists: TaskList[];              // lists the change created (the Inbox, on first use); apply them like list.changed
}

export interface TaskListFields { name?: string; color?: string | null; icon?: string | null; archived?: boolean }
export interface CreateTaskListRequest { name: string; color?: string | null; icon?: string | null }
export interface UpdateTaskListRequest { changes: TaskListFields; base?: TaskListFields }
export interface ReorderRequest { ids: string[]; after: string | null }
export interface SectionRequest { name: string }
export interface TaskListWriteResult {
  lists: TaskList[];              // the created, changed or reordered lists, after the change
  files: FileEntry[];             // list files written or created
  createdFolders: VaultPath[];
  moved: MovedFile | null;        // a rename that renamed the list's file
  trash: TrashEntry | null;       // a delete: the trash entry of the list's file
}

export interface TaskEvent { task: Task; origin: string | null }
export interface TaskDeletedEvent { id: string; listId: string; origin: string | null }
export interface ListChangedEvent { listId: string; list: TaskList | null; origin: string | null }
export interface TaskEventMap {
  'task.created': TaskEvent;
  'task.changed': TaskEvent;
  'task.deleted': TaskDeletedEvent;
  'list.changed': ListChangedEvent;
}
export type TaskEventName = keyof TaskEventMap;
export const TASK_EVENT_NAMES: readonly TaskEventName[] = ['task.created', 'task.changed', 'task.deleted', 'list.changed'];
// ---------- Flashcards (API.md §34, ROADMAP item 34) ----------
export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy' | 'reset';
export type FlashcardPhase = 'new' | 'learning' | 'review' | 'relearning';
export interface FlashcardConfig {
  tags: string[];               // without '#'; nested tags count too
  foldersAsDecks: boolean;      // decks are folders, and every note with cards counts
  newPerDay: number;
  reviewsPerDay: number;
  retention: number;            // FSRS desired retention, 0.7 to 0.99
  maximumInterval: number;      // days
  learningSteps: string[];      // '1m', '10m', '1d'
  relearningSteps: string[];
  fuzz: boolean;
  dayStartsAt: number;          // local hour when a new study day starts
}
export interface FlashcardCardState {
  due: IsoInstant;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  phase: FlashcardPhase;
  lastReview: IsoInstant | null;
  n: number;                    // the number of reviews this state was computed from
}
export interface FlashcardCard {
  note: VaultPath | null;
  front: string | null;
  state: FlashcardCardState | null;
  reviews: string[];            // "<instant> <rating>[ <ms>]", oldest first
}
export interface FlashcardsResponse { config: FlashcardConfig; cards: Record<string, FlashcardCard>; version: Version | null }
export interface FlashcardReview {
  card: string;
  at: IsoInstant;
  rating: FlashcardRating;
  ms?: number;
  note?: VaultPath;
  front?: string;
  state?: FlashcardCardState;
  from?: string;                // the card's previous id, when its text was edited
}
export interface FlashcardReviewRequest { reviews: FlashcardReview[] }
export interface FlashcardUndoRequest { card: string; at: IsoInstant; state?: FlashcardCardState }
export interface FlashcardPruneRequest { cards: string[] }
export interface FlashcardConfigUpdateRequest { config: Partial<{ [K in keyof FlashcardConfig]: FlashcardConfig[K] | null }> }
export interface FlashcardWriteResult { cards: Record<string, FlashcardCard | null>; version: Version }
export interface FlashcardNote { path: VaultPath; version: Version; content: string }
export interface FlashcardNotesResponse { config: FlashcardConfig; notes: FlashcardNote[] }
export interface FlashcardsChangedEvent {
  cards: Record<string, FlashcardCard | null> | null;   // null: too many changed, refetch
  config: FlashcardConfig | null;
  version: Version;
  origin: string | null;
}

// ---------- Habits (API.md §35, ROADMAP item 35) ----------
export interface HabitNote { path: VaultPath; version: Version; properties: Record<string, unknown> }   // the frontmatter
export interface DailyNoteValues { path: VaultPath; values: Record<string, boolean | number | string> }
export interface HabitsResponse {
  folder: VaultPath;            // where new habits go: 'Habits'
  tag: string;                  // 'habit': notes with #habit anywhere are habits too
  habits: HabitNote[];
  dailyFolder: VaultPath;       // the daily-notes folder, as it is in the vault
  daily: DailyNoteValues[];     // daily notes with simple frontmatter values
}

// ---------- Calendar (API.md §25, ROADMAP item 14) ----------
export interface DatedNote {
  path: VaultPath;
  day: LocalDate;               // the date part of value
  property: string;             // the frontmatter key, as written: 'date'
  value: string;                // as written: '2026-10-21', '2026-10-21T09:30' or '[[2026-10-21]]'
}
export interface DatedNotesResponse {
  from: LocalDate;
  to: LocalDate;
  properties: string[];         // the properties read, ['date'] by default
  notes: DatedNote[];           // by day, then path; a note once per day
}

// ---------- Reminders (API.md §28, ROADMAP items 9 and 4c) ----------
export type ReminderRouteId = 'webPush' | 'ntfy' | 'inApp';
export interface PushDevice {
  id: string;
  name: string;
  createdAt: IsoInstant;
  lastSuccessAt: IsoInstant | null;
  lastError: string | null;
  lastErrorAt: IsoInstant | null;
}
export interface UpcomingReminder { taskId: string; title: string; at: LocalDateTime }
export interface RemindersStatus {
  zone: string;                   // the IANA zone reminders are read in
  zoneReported: boolean;          // false: no device reported one yet, the server's zone is used
  serverZone: string;
  webPush: { available: boolean; reason: string | null; publicKey: string | null; devices: PushDevice[] };
  ntfy: { configured: boolean; reason: string | null; server: string | null; ownTopic: boolean };
  inApp: { connections: number };
  lastDeliveredAt: IsoInstant | null;
  lastError: string | null;
  lastErrorAt: IsoInstant | null;
  upcoming: UpcomingReminder[];   // the next five, soonest first
}
export interface ReminderZoneRequest { zone: string }
export interface PushKey { publicKey: string }   // base64url, the applicationServerKey
export interface PushSubscriptionRequest { endpoint: string; keys: { p256dh: string; auth: string }; name: string }
export interface ReminderTestRequest { route: ReminderRouteId; deviceId?: string }
export interface ReminderTestResult { sent: boolean; error: string | null }
export interface ReminderActionRequest { taskId: string; at: LocalDateTime; minutes?: number }   // minutes: snooze only, default 10
export interface ReminderActionResult { changed: boolean; until: IsoInstant | null }
/** `reminder.due` (§28.5), registered at runtime by the reminders feature. */
export interface ReminderDueEvent {
  key: string;
  kind: 'task' | 'daily' | 'test';
  taskId: string | null;
  at: LocalDateTime | null;
  title: string;
  body: string;
  url: string;                    // an app path, such as '/x/tasks/today?task=<id>'
  sentAt: IsoInstant;
}

// ---------- Vaults (API.md §41, ROADMAP item 37) ----------
// Server-wide: GET and POST /api/vaults are never prefixed. Every other endpoint of an extra vault
// is its default-vault path with /api replaced by /api/v/<name>.
export type VaultState = 'starting' | 'ready' | 'failed';
export interface VaultInfo {
  name: string;                 // 1-32 of a-z 0-9 -, starting and ending with a letter or digit
  isDefault: boolean;           // the vault at NOTES_VAULT_DIR, served unprefixed; listed first
  state: VaultState;            // starting: requests get 503 vault-unavailable until ready
  url: string;                  // where its app opens: '/' or '/v/<name>/'
}
export interface VaultsResponse { vaults: VaultInfo[]; canCreate: boolean }
export interface CreateVaultRequest { name: string }   // 201 VaultInfo (state 'starting')

// ---------- Public publishing (API.md §26, ROADMAP item 26) ----------
export type PublishedNoteState = 'current' | 'changed' | 'source-missing' | 'snapshot-missing';
export interface PublishedNote {
  path: VaultPath;              // follows moves and renames made in the app
  slug: string;                 // the public page is /p/<slug>
  title: string;
  url: string;                  // baseUrl + '/p/' + slug, or only the path when there is no base URL
  publishedAt: IsoInstant;
  state: PublishedNoteState;    // changed: edited since publishing; the public page shows the snapshot
}
export interface PublishResponse {
  enabled: boolean;             // NOTES_PUBLISH_ENABLED; false: nothing is served or publishable
  baseUrl: string | null;       // NOTES_PUBLISH_BASE_URL without a trailing slash
  notes: PublishedNote[];
}
export interface PublishRequest { path: VaultPath; slug?: string; title?: string }   // omitted: keep, or derive
// ---------- Properties (API.md §38, ROADMAP item 13) ----------
export type PropertyType = 'text' | 'multitext' | 'number' | 'checkbox' | 'date' | 'datetime' | 'aliases' | 'tags';
export interface PropertyInfo {
  name: string;                 // as most notes spell it; names compare case-insensitively
  count: number;                // notes that have it
  type: PropertyType | null;    // in the vault's type registry, or null
  inferred: PropertyType;       // what its values look like
}
export interface PropertiesResponse { properties: PropertyInfo[] }   // sorted by name
export interface PropertyTypesResponse {
  types: Record<string, string>;   // name → type, in file order (an unknown type is kept as written)
  version: Version | null;         // of .notesapp/types.json; null while it does not exist
  source: 'notesapp' | 'obsidian' | null;   // obsidian: read from .obsidian/types.json until the first change
}
export interface PropertyTypeRequest { name: string; type: PropertyType | null }   // null removes the type
export interface PropertyValue { value: string; count: number }
export interface PropertyValuesResponse { name: string; values: PropertyValue[] }   // most used first, at most 500
export interface PropertyRenameRequest { from: string; to: string; dryRun?: boolean }
export interface PropertyUpdate { path: VaultPath; version: Version | null }   // version null in a dry run
export interface PropertyRenameResult {
  dryRun: boolean;
  from: string;
  to: string;
  updates: PropertyUpdate[];
  failed: FailedUpdate[];       // 'property-exists': the note already has the new name
  typeMoved: boolean;           // the property's type moved to the new name
  commitId: string | null;
}
export interface PropertyTypesChangedEvent { version: Version; origin: string | null }
// ---------- Scripts in notes (API.md §40, ROADMAP items 40 and 17) ----------
export interface NoteTask {
  line: number;                 // 0-based line in the note
  status: string;               // the character between the brackets: ' ', 'x', '/', …
  done: boolean;                // status is x or X
  text: string;
}
export interface QueriedNote {
  path: VaultPath;
  title: string;                // the basename
  aliases: string[];
  tags: string[];               // distinct, without '#', in order of first appearance
  frontmatter: Record<string, unknown> | null;
  mtime: IsoInstant;
  size: number;
  links: VaultPath[];           // where the note's links and embeds resolve, distinct
  tasks: NoteTask[] | null;     // with tasks=true; null otherwise
}
export interface NotesQueryResponse {
  notes: QueriedNote[];         // in path order, at most limit
  total: number;                // every match
  truncated: boolean;           // total > notes.length
}
