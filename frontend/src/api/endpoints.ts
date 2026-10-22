// One typed function per endpoint (API.md §18). `api` is the HTTP implementation unless the
// dev-only in-memory mock replaced it at startup (VITE_MOCK_API=1).
import { apiFetch, query } from './client';
import type {
  AlertTestResult,
  AttachmentResult,
  BacklinksResponse,
  BookmarksResponse,
  PublishRequest,
  PublishResponse,
  PublishedNote,
  BookmarksUpdateRequest,
  CaptureRequest,
  CaptureResult,
  CaptureTarget,
  ChangesResponse,
  CommitResult,
  CompatReport,
  CreateFileRequest,
  DeletedFilesResponse,
  FileEntry,
  FolderResult,
  GraphResponse,
  HeadingRenameRequest,
  HeadingRenameResult,
  HistoryContent,
  HistoryResponse,
  HistoryRestoreRequest,
  HistoryRestoreResult,
  MeResponse,
  MirrorStatus,
  MoveRequest,
  MoveResult,
  NoteMeta,
  PurgeResult,
  ResolveRequest,
  ResolveResponse,
  RestoreRequest,
  RestoreResult,
  SaveFileRequest,
  SavedSearchesResponse,
  SavedSearchesUpdateRequest,
  SearchResponse,
  SearchSort,
  SettingsResponse,
  SettingsUpdateRequest,
  StatusDetails,
  StatusResponse,
  TagsResponse,
  TemplatesResponse,
  TextFile,
  TimelineResponse,
  TrashEntry,
  TranscriptionResult,
  TranscriptionStatus,
  TrashListResponse,
  TreeResponse,
  WriteResult,
} from './types';

/** The subset of `EventSource` the app uses, so the mock can provide a fake stream. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface WriteOptions {
  idempotencyKey?: string;
}

export interface SaveOptions {
  keepalive?: boolean;
}

/** Query parameters of POST /api/capture/file (API.md §8.6). */
export interface CaptureFileParams {
  text?: string | null;
  target?: CaptureTarget;
  date?: string;
  time?: string;
  tz?: string;
}

export type RawConflict = 'fail' | 'rename' | 'overwrite';

export interface SearchOptions {
  limit?: number;
  sort?: SearchSort;
  prefix?: boolean;
  fuzzy?: boolean;
}

export interface TimelineFilter {
  path?: string;
  author?: string;
  since?: string;
  until?: string;
}

export interface Endpoints {
  getMe(): Promise<MeResponse>;
  getStatus(): Promise<StatusResponse>;
  getStatusDetails(): Promise<StatusDetails>;
  sendTestAlert(): Promise<AlertTestResult>;
  getSettings(): Promise<SettingsResponse>;
  putSettings(req: SettingsUpdateRequest): Promise<SettingsResponse>;
  getTree(): Promise<TreeResponse>;
  readFile(path: string): Promise<TextFile>;
  createFile(req: CreateFileRequest, opts?: WriteOptions): Promise<WriteResult>;
  saveFile(path: string, req: SaveFileRequest, opts?: SaveOptions): Promise<WriteResult>;
  deleteFile(path: string): Promise<TrashEntry>;
  uploadRaw(path: string, body: Blob, onConflict: RawConflict, opts?: WriteOptions): Promise<WriteResult>;
  uploadAttachment(name: string, source: string | null, body: Blob, opts?: WriteOptions): Promise<AttachmentResult>;
  createFolder(path: string): Promise<FolderResult>;
  capture(req: CaptureRequest, opts?: WriteOptions): Promise<CaptureResult>;
  captureFile(name: string, body: Blob, params: CaptureFileParams, opts?: WriteOptions): Promise<CaptureResult>;
  deleteFolder(path: string): Promise<TrashEntry>;
  move(req: MoveRequest): Promise<MoveResult>;
  getNoteMeta(path: string): Promise<NoteMeta>;
  getBacklinks(path: string, unlinked: boolean): Promise<BacklinksResponse>;
  resolveLinks(req: ResolveRequest): Promise<ResolveResponse>;
  search(q: string, opts?: SearchOptions): Promise<SearchResponse>;
  getSavedSearches(): Promise<SavedSearchesResponse>;
  putSavedSearches(req: SavedSearchesUpdateRequest): Promise<SavedSearchesResponse>;
  getTags(): Promise<TagsResponse>;
  /** The link graph (API.md §11.4); with `since`, an unchanged graph comes back empty with `unchanged: true`. */
  getGraph(since?: string): Promise<GraphResponse>;
  /** The Obsidian compatibility report (API.md §11.5). */
  getCompat(): Promise<CompatReport>;
  listTrash(): Promise<TrashListResponse>;
  restoreTrash(id: string, req?: RestoreRequest): Promise<RestoreResult>;
  purgeTrashEntry(id: string): Promise<void>;
  emptyTrash(): Promise<PurgeResult>;
  getHistory(path: string, opts?: { limit?: number; offset?: number }): Promise<HistoryResponse>;
  getHistoryContent(path: string, commit: string): Promise<HistoryContent>;
  restoreHistory(req: HistoryRestoreRequest): Promise<HistoryRestoreResult>;
  commitHistory(): Promise<CommitResult>;
  pushMirror(): Promise<MirrorStatus>;
  getHistoryLog(filter: TimelineFilter, opts?: { limit?: number; offset?: number }): Promise<TimelineResponse>;
  getHistoryChanges(filter: TimelineFilter): Promise<ChangesResponse>;
  getDeletedFiles(q: string, opts?: { limit?: number; offset?: number }): Promise<DeletedFilesResponse>;
  getTemplates(): Promise<TemplatesResponse>;
  getBookmarks(): Promise<BookmarksResponse>;
  putBookmarks(req: BookmarksUpdateRequest): Promise<BookmarksResponse>;
  renameHeading(req: HeadingRenameRequest): Promise<HeadingRenameResult>;
  /** Published notes and whether publishing is on (API.md §26.1). */
  getPublish(): Promise<PublishResponse>;
  /** Publishes or republishes a note (API.md §26.2). */
  publishNote(req: PublishRequest): Promise<PublishedNote>;
  /** Unpublishes a note: its public page is gone at once (API.md §26.3). */
  unpublishNote(path: string): Promise<void>;
  getTranscriptionStatus(): Promise<TranscriptionStatus>;
  /** The transcript of a recording in the vault (API.md §23.2); it can take minutes. */
  transcribe(path: string): Promise<TranscriptionResult>;
  /** Content-addressed raw URL (API.md §9.1). */
  rawUrl(entry: Pick<FileEntry, 'path' | 'size' | 'mtime'>, opts?: { download?: boolean }): string;
  trashRawUrl(id: string): string;
  historyRawUrl(path: string, commit: string): string;
  openEvents(clientId: string, lastEventId: string | null): EventSourceLike;
}

const p = (path: string) => ({ path });

export const httpEndpoints: Endpoints = {
  getMe: () => apiFetch('/api/me'),
  getStatus: () => apiFetch('/api/status'),
  getStatusDetails: () => apiFetch('/api/status/details'),
  sendTestAlert: () => apiFetch('/api/alerts/test', { method: 'POST' }),
  getSettings: () => apiFetch('/api/settings'),
  putSettings: (req) => apiFetch('/api/settings', { method: 'PUT', json: req }),
  getTree: () => apiFetch('/api/tree'),
  readFile: (path) => apiFetch('/api/files' + query(p(path))),
  createFile: (req, opts) => apiFetch('/api/files', { method: 'POST', json: req, idempotencyKey: opts?.idempotencyKey }),
  saveFile: (path, req, opts) =>
    apiFetch('/api/files' + query(p(path)), { method: 'PUT', json: req, keepalive: opts?.keepalive }),
  deleteFile: (path) => apiFetch('/api/files' + query(p(path)), { method: 'DELETE' }),
  uploadRaw: (path, body, onConflict, opts) =>
    apiFetch('/api/files/raw' + query({ path, onConflict }), {
      method: 'PUT',
      body,
      contentType: body.type || 'application/octet-stream',
      idempotencyKey: opts?.idempotencyKey,
    }),
  uploadAttachment: (name, source, body, opts) =>
    apiFetch('/api/attachments' + query({ name, source }), {
      method: 'POST',
      body,
      contentType: body.type || 'application/octet-stream',
      idempotencyKey: opts?.idempotencyKey,
    }),
  createFolder: (path) => apiFetch('/api/folders', { method: 'POST', json: { path } }),
  capture: (req, opts) => apiFetch('/api/capture', { method: 'POST', json: req, idempotencyKey: opts?.idempotencyKey }),
  captureFile: (name, body, params, opts) =>
    apiFetch('/api/capture/file' + query({ name, text: params.text, target: params.target, date: params.date, time: params.time, tz: params.tz }), {
      method: 'POST',
      body,
      contentType: body.type || 'application/octet-stream',
      idempotencyKey: opts?.idempotencyKey,
    }),
  deleteFolder: (path) => apiFetch('/api/folders' + query(p(path)), { method: 'DELETE' }),
  move: (req) => apiFetch('/api/move', { method: 'POST', json: req }),
  getNoteMeta: (path) => apiFetch('/api/notes/meta' + query(p(path))),
  getBacklinks: (path, unlinked) => apiFetch('/api/notes/backlinks' + query({ path, unlinked })),
  resolveLinks: (req) => apiFetch('/api/links/resolve', { method: 'POST', json: req }),
  search: (q, opts = {}) =>
    apiFetch('/api/search' + query({ q, limit: opts.limit, sort: opts.sort, prefix: opts.prefix, fuzzy: opts.fuzzy })),
  getSavedSearches: () => apiFetch('/api/searches'),
  putSavedSearches: (req) => apiFetch('/api/searches', { method: 'PUT', json: req }),
  getTags: () => apiFetch('/api/tags'),
  getGraph: (since) => apiFetch('/api/graph' + query({ since })),
  getCompat: () => apiFetch('/api/compat'),
  listTrash: () => apiFetch('/api/trash'),
  restoreTrash: (id, req) => apiFetch(`/api/trash/${encodeURIComponent(id)}/restore`, { method: 'POST', json: req ?? {} }),
  purgeTrashEntry: (id) => apiFetch(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  emptyTrash: () => apiFetch('/api/trash', { method: 'DELETE' }),
  getHistory: (path, opts = {}) => apiFetch('/api/history' + query({ path, limit: opts.limit, offset: opts.offset })),
  getHistoryContent: (path, commit) => apiFetch('/api/history/content' + query({ path, commit })),
  restoreHistory: (req) => apiFetch('/api/history/restore', { method: 'POST', json: req }),
  commitHistory: () => apiFetch('/api/history/commit', { method: 'POST' }),
  pushMirror: () => apiFetch('/api/mirror/push', { method: 'POST' }),
  getHistoryLog: (f, opts = {}) =>
    apiFetch('/api/history/log' + query({ path: f.path, author: f.author, since: f.since, until: f.until, limit: opts.limit, offset: opts.offset })),
  getHistoryChanges: (f) => apiFetch('/api/history/changes' + query({ since: f.since, until: f.until, path: f.path })),
  getDeletedFiles: (q, opts = {}) => apiFetch('/api/history/deleted' + query({ q: q || undefined, limit: opts.limit, offset: opts.offset })),
  getTemplates: () => apiFetch('/api/templates'),
  getBookmarks: () => apiFetch('/api/bookmarks'),
  putBookmarks: (req) => apiFetch('/api/bookmarks', { method: 'PUT', json: req }),
  renameHeading: (req) => apiFetch('/api/notes/rename-heading', { method: 'POST', json: req }),
  getPublish: () => apiFetch('/api/publish'),
  publishNote: (req) => apiFetch('/api/publish', { method: 'POST', json: req }),
  unpublishNote: (path) => apiFetch('/api/publish' + query(p(path)), { method: 'DELETE' }),
  getTranscriptionStatus: () => apiFetch('/api/transcription'),
  transcribe: (path) => apiFetch('/api/transcriptions', { method: 'POST', json: { path } }),
  rawUrl: (entry, opts) =>
    '/api/files/raw?path=' +
    encodeURIComponent(entry.path) +
    '&v=' +
    entry.size +
    '-' +
    Date.parse(entry.mtime) +
    (opts?.download ? '&download=true' : ''),
  trashRawUrl: (id) => `/api/trash/${encodeURIComponent(id)}/raw`,
  historyRawUrl: (path, commit) => '/api/history/raw' + query({ path, commit }),
  openEvents: (clientId, lastEventId) =>
    new EventSource('/api/events' + query({ clientId, lastEventId: lastEventId ?? undefined })) as EventSourceLike,
};

/** The active implementation. Swapped for the in-memory mock before the app renders (dev only). */
export const api: Endpoints = { ...httpEndpoints };

export function installEndpoints(impl: Endpoints): void {
  Object.assign(api, impl);
}
