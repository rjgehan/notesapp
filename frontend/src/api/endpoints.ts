// One typed function per endpoint (API.md §18). `api` is the HTTP implementation unless the
// dev-only in-memory mock replaced it at startup (VITE_MOCK_API=1).
import { apiFetch, query } from './client';
import type {
  AlertTestResult,
  AttachmentResult,
  BacklinksResponse,
  CommitResult,
  CreateFileRequest,
  FileEntry,
  FolderResult,
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
  SearchResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  StatusDetails,
  StatusResponse,
  TagsResponse,
  TemplatesResponse,
  TextFile,
  TrashEntry,
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

export type RawConflict = 'fail' | 'rename' | 'overwrite';

export interface SearchOptions {
  limit?: number;
  sort?: 'relevance' | 'mtime';
  prefix?: boolean;
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
  deleteFolder(path: string): Promise<TrashEntry>;
  move(req: MoveRequest): Promise<MoveResult>;
  getNoteMeta(path: string): Promise<NoteMeta>;
  getBacklinks(path: string, unlinked: boolean): Promise<BacklinksResponse>;
  resolveLinks(req: ResolveRequest): Promise<ResolveResponse>;
  search(q: string, opts?: SearchOptions): Promise<SearchResponse>;
  getTags(): Promise<TagsResponse>;
  listTrash(): Promise<TrashListResponse>;
  restoreTrash(id: string, req?: RestoreRequest): Promise<RestoreResult>;
  purgeTrashEntry(id: string): Promise<void>;
  emptyTrash(): Promise<PurgeResult>;
  getHistory(path: string, opts?: { limit?: number; offset?: number }): Promise<HistoryResponse>;
  getHistoryContent(path: string, commit: string): Promise<HistoryContent>;
  restoreHistory(req: HistoryRestoreRequest): Promise<HistoryRestoreResult>;
  commitHistory(): Promise<CommitResult>;
  pushMirror(): Promise<MirrorStatus>;
  getTemplates(): Promise<TemplatesResponse>;
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
  deleteFolder: (path) => apiFetch('/api/folders' + query(p(path)), { method: 'DELETE' }),
  move: (req) => apiFetch('/api/move', { method: 'POST', json: req }),
  getNoteMeta: (path) => apiFetch('/api/notes/meta' + query(p(path))),
  getBacklinks: (path, unlinked) => apiFetch('/api/notes/backlinks' + query({ path, unlinked })),
  resolveLinks: (req) => apiFetch('/api/links/resolve', { method: 'POST', json: req }),
  search: (q, opts = {}) => apiFetch('/api/search' + query({ q, limit: opts.limit, sort: opts.sort, prefix: opts.prefix })),
  getTags: () => apiFetch('/api/tags'),
  listTrash: () => apiFetch('/api/trash'),
  restoreTrash: (id, req) => apiFetch(`/api/trash/${encodeURIComponent(id)}/restore`, { method: 'POST', json: req ?? {} }),
  purgeTrashEntry: (id) => apiFetch(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  emptyTrash: () => apiFetch('/api/trash', { method: 'DELETE' }),
  getHistory: (path, opts = {}) => apiFetch('/api/history' + query({ path, limit: opts.limit, offset: opts.offset })),
  getHistoryContent: (path, commit) => apiFetch('/api/history/content' + query({ path, commit })),
  restoreHistory: (req) => apiFetch('/api/history/restore', { method: 'POST', json: req }),
  commitHistory: () => apiFetch('/api/history/commit', { method: 'POST' }),
  pushMirror: () => apiFetch('/api/mirror/push', { method: 'POST' }),
  getTemplates: () => apiFetch('/api/templates'),
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
