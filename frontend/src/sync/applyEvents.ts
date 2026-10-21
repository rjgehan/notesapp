// SSE event → cache patches and invalidations (DESIGN §6.3), plus the own-mutation handlers that
// patch the caches from this tab's HTTP responses (its own content events are not echoed back,
// API.md §16.4) and run the same invalidations as the matching remote event.
// Every handler is idempotent: applying the same event or result twice changes nothing more.
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queryKeys';
import type {
  AttachmentResult,
  CaptureResult,
  FileDeletedEvent,
  FileEntry,
  FileEvent,
  FolderDeletedEvent,
  FolderEvent,
  FolderResult,
  HeadingRenameResult,
  HistoryCommittedEvent,
  HistoryRestoreResult,
  MovedEvent,
  MoveResult,
  RestoreResult,
  Settings,
  TrashEntry,
} from '../api/types';
import { folderOf, isWithin } from '../features/paths';
import type { DocumentSession } from './DocumentSession';
import type { DraftStore } from './drafts';
import type { MoveMap } from './moves';
import { addFolders, invalidateContentQueries, moveEntry, refreshFileQuery, removeFile, removeFolder, setFileVersion, upsertFiles } from './treePatch';

export interface SyncTarget {
  qc: QueryClient;
  documents: {
    get(path: string): DocumentSession | undefined;
    all(): DocumentSession[];
    applyMove(from: string, to: string, type: 'file' | 'folder'): void;
  };
  moves: MoveMap;
  drafts: Pick<DraftStore, 'rekey'>;
  settings(): Settings;
  /** A file or folder moved (any origin): re-route the open note, keep recents and UI state current. */
  onEntryMoved(from: string, to: string, type: 'file' | 'folder'): void;
  onDraftFailure(): void;
}

function invalidate(qc: QueryClient, ...keys: ReadonlyArray<readonly unknown[]>): void {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

function inTemplates(t: SyncTarget, path: string): boolean {
  return isWithin(path, t.settings().templates.folder);
}

/** Sessions at `path` or (for a folder) below it. */
function sessionsUnder(t: SyncTarget, path: string): DocumentSession[] {
  return t.documents.all().filter((s) => isWithin(s.path, path));
}

// ---------- remote events (API.md §16.4) ----------

export function applyEvent(t: SyncTarget, name: string, data: unknown): void {
  const qc = t.qc;
  switch (name) {
    case 'file.created': {
      const { file } = data as FileEvent;
      // A note created at a moved-away path is another note: moves recorded from it are stale.
      t.moves.created(file.path);
      upsertFiles(qc, [file]);
      refreshFileQuery(qc, file.path);
      // A session left on a tombstone at this path (restored or recreated elsewhere) catches up.
      void t.documents.get(file.path)?.onRemoteChanged(file);
      invalidate(qc, queryKeys.tags(), queryKeys.searchAll(), queryKeys.backlinksAll());
      if (inTemplates(t, file.path)) invalidate(qc, queryKeys.templates());
      return;
    }
    case 'file.changed': {
      const { file } = data as FileEvent;
      upsertFiles(qc, [file]);
      // Embeds read ['file', path] even when the note has a session (DESIGN §6.3).
      refreshFileQuery(qc, file.path);
      void t.documents.get(file.path)?.onRemoteChanged(file);
      invalidateContentQueries(qc, file.path);
      return;
    }
    case 'file.deleted': {
      const { path, trashId } = data as FileDeletedEvent;
      removeFile(qc, path);
      t.documents.get(path)?.onRemoteDeleted(trashId);
      invalidate(qc, queryKeys.backlinksAll(), queryKeys.tags(), queryKeys.searchAll());
      if (inTemplates(t, path)) invalidate(qc, queryKeys.templates());
      return;
    }
    case 'folder.created': {
      addFolders(qc, [(data as FolderEvent).path]);
      return;
    }
    case 'folder.deleted': {
      const { path, trashId } = data as FolderDeletedEvent;
      removeFolder(qc, path);
      for (const s of sessionsUnder(t, path)) s.onRemoteDeleted(trashId);
      invalidate(qc, queryKeys.backlinksAll(), queryKeys.tags(), queryKeys.searchAll());
      if (inTemplates(t, path) || isWithin(t.settings().templates.folder, path)) invalidate(qc, queryKeys.templates());
      return;
    }
    case 'entry.moved': {
      const { from, to, type } = data as MovedEvent;
      applyMove(t, from, to, type);
      invalidate(qc, queryKeys.backlinksAll());
      return;
    }
    case 'trash.changed':
      invalidate(qc, queryKeys.trash());
      return;
    case 'history.committed': {
      const { paths, truncated } = data as HistoryCommittedEvent;
      if (truncated) invalidate(qc, queryKeys.historyAll());
      else for (const p of paths) invalidate(qc, queryKeys.history(p));
      invalidate(qc, queryKeys.vaultHistoryAll());
      invalidate(qc, queryKeys.status());
      return;
    }
    case 'settings.changed':
      invalidate(qc, queryKeys.settings());
      return;
    case 'bookmarks.changed':
      invalidate(qc, queryKeys.bookmarks());
      return;
    case 'searches.changed':
      invalidate(qc, queryKeys.savedSearches());
      return;
    case 'status.changed':
      invalidate(qc, queryKeys.status());
      return;
    default:
      return;
  }
}

/** Re-keys tree entries, the move map, drafts and open sessions for one move. */
function applyMove(t: SyncTarget, from: string, to: string, type: 'file' | 'folder'): void {
  moveEntry(t.qc, from, to, type);
  t.moves.record(from, to, type);
  // Drafts of notes this tab does not have open are re-keyed too, so none is ever orphaned.
  void t.drafts.rekey(from, to).catch(() => t.onDraftFailure());
  t.documents.applyMove(from, to, type);
  t.onEntryMoved(from, to, type);
}

// ---------- own mutations (DESIGN §6.3 "Own mutations") ----------

export function applyAttachmentResult(t: SyncTarget, r: AttachmentResult): void {
  if (r.created) t.moves.created(r.file.path);
  addFolders(t.qc, r.createdFolders);
  upsertFiles(t.qc, [r.file]);
}

export function applyFolderResult(t: SyncTarget, r: FolderResult): void {
  addFolders(t.qc, [...r.createdFolders, r.folder.path]);
}

export function applyTrashEntry(t: SyncTarget, entry: TrashEntry): void {
  if (entry.type === 'file') removeFile(t.qc, entry.originalPath);
  else removeFolder(t.qc, entry.originalPath);
  invalidate(t.qc, queryKeys.backlinksAll(), queryKeys.tags(), queryKeys.searchAll(), queryKeys.trash());
  if (inTemplates(t, entry.originalPath)) invalidate(t.qc, queryKeys.templates());
}

export function applyMoveResult(t: SyncTarget, r: MoveResult): void {
  if (r.dryRun) return;
  addFolders(t.qc, r.createdFolders);
  applyMove(t, r.from, r.to, r.type);
  for (const u of r.linkUpdates) {
    if (u.version !== null) setFileVersion(t.qc, u.path, u.version);
    refreshFileQuery(t.qc, u.path);
    // The pre-move flush left the session clean, so it re-fetches and applies silently.
    void t.documents.get(u.path)?.onRemoteChanged({ version: u.version }, { quiet: true });
  }
  invalidate(t.qc, queryKeys.backlinksAll(), queryKeys.tags(), queryKeys.searchAll());
  if (inTemplates(t, r.from) || inTemplates(t, r.to)) invalidate(t.qc, queryKeys.templates());
}

/** Notes whose links to a renamed heading were updated (API.md §22): like a move's `linkUpdates`. */
export function applyHeadingRenameResult(t: SyncTarget, r: HeadingRenameResult): void {
  if (r.dryRun) return;
  for (const u of r.linkUpdates) {
    if (u.version !== null) setFileVersion(t.qc, u.path, u.version);
    refreshFileQuery(t.qc, u.path);
    void t.documents.get(u.path)?.onRemoteChanged({ version: u.version }, { quiet: true });
  }
  invalidate(t.qc, queryKeys.backlinksAll(), queryKeys.searchAll());
}

export function applyRestoreResult(t: SyncTarget, r: RestoreResult): void {
  addFolders(t.qc, r.createdFolders);
  for (const f of r.files) t.moves.created(f.path);
  upsertFiles(t.qc, r.files);
  for (const f of r.files) restoredInto(t, f);
  invalidate(t.qc, queryKeys.backlinksAll(), queryKeys.tags(), queryKeys.searchAll(), queryKeys.trash());
  if (r.files.some((f) => inTemplates(t, f.path))) invalidate(t.qc, queryKeys.templates());
}

export function applyHistoryRestoreResult(t: SyncTarget, r: HistoryRestoreResult): void {
  addFolders(t.qc, r.createdFolders);
  upsertFiles(t.qc, [r.file]);
  restoredInto(t, r.file);
  invalidateContentQueries(t.qc, r.file.path);
}

/** A file came back with new content: its open session adopts it, otherwise the cache is dropped. */
function restoredInto(t: SyncTarget, file: FileEntry): void {
  refreshFileQuery(t.qc, file.path);
  void t.documents.get(file.path)?.onRemoteChanged(file, { quiet: true });
}

/**
 * Own quick capture (API.md §8.5): the server appended to the note (its new text is not in the
 * response), so this tab treats it like another device's change: an open, clean session
 * re-reads it; the capture flushes the session first, so it is clean (DESIGN §6.27).
 */
export function applyCaptureResult(t: SyncTarget, r: CaptureResult): void {
  if (r.created) t.moves.created(r.file.path);
  addFolders(t.qc, r.attachment ? [...r.createdFolders, folderOf(r.attachment.path)].filter((f) => f !== '') : r.createdFolders);
  upsertFiles(t.qc, r.attachment ? [r.file, r.attachment] : [r.file]);
  if (r.attachment) t.moves.created(r.attachment.path);
  restoredInto(t, r.file);
  invalidateContentQueries(t.qc, r.file.path);
}
