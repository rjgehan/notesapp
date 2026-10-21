// File operations (DESIGN §6.15): optimistic new note, rename, move (with Undo), delete, new
// folder, copy link and download. Every request flushes the affected sessions first and patches
// the caches from its own response (DESIGN §6.3 "Own mutations").
import { isProblem } from '../api/client';
import { api } from '../api/endpoints';
import { currentSettings, currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import type { FailedUpdate, FileEntry, MoveResult, Settings } from '../api/types';
import { newIdempotencyKey } from '../state/clientId';
import { clearPendingNote, startPendingNote, usePendingNote } from '../state/pendingNote';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
import { applyFolderResult, applyMoveResult, applyRestoreResult, applyTrashEntry } from '../sync/applyEvents';
import { documents } from '../sync/instance';
import { syncTarget } from '../sync/liveSync';
import { applyWriteResult } from '../sync/treePatch';
import { assembleLink, linkText } from './links';
import { activePath, navigateTo, openPath } from './navigation';
import { displayName, extensionOf, folderOf, isWithin, joinPath, lastSegment, newNameError, newPathError, noteRoute, rebasePath } from './paths';
import { forgetRecent } from './recent';
import { toastError } from './errors';
import { afterOpen, requestNoteFocus } from './focus';
import { retitleText } from './templateTitle';

/** The default new-note location (API.md §5 `newNoteLocation`). */
export function newNoteFolder(fromPath: string | null, settings: Settings = currentSettings()): string {
  const s = settings.files;
  if (s.newNoteLocation === 'folder') return s.newNoteFolder;
  if (s.newNoteLocation === 'current') return fromPath ? folderOf(fromPath) : '';
  return '';
}

/** Inline validation of a new name (one segment, extension included). */
export function validateNewName(name: string): string | null {
  if (name.includes('/') || name.includes('\\')) return 'Use Move to… to change folders';
  if (name.trim() === '') return 'A name is required';
  return newNameError(name);
}

/** The name with the entry's extension kept (the title edits the basename only). */
export function nameWithExtension(path: string, basename: string, type: 'file' | 'folder'): string {
  if (type === 'folder') return basename;
  const ext = extensionOf(path);
  const current = lastSegment(path);
  const hasExt = ext !== '' && current.toLowerCase().endsWith('.' + ext);
  return hasExt ? `${basename}${current.slice(current.length - ext.length - 1)}` : basename;
}

// ---------- new note (optimistic) ----------

let pendingSeq = 0;

/** A template rendered for a title (New note from template). */
export type TitledContent = (title: string) => string;

/** The note created from a template whose `{{title}}` still follows its name (one at a time). */
let titled: { path: string; render: TitledContent; title: string } | null = null;

/**
 * The note created from a template at `from` is now named `to` (the new-note rename, its inline
 * title): the lines its template rendered with the old title are rendered with the new one, as
 * one ordinary edit of the note.
 */
export async function retitleNewNote(from: string, to: string): Promise<void> {
  const t = titled;
  if (!t || t.path !== from) return;
  titled = null;
  const title = displayName(to);
  if (title !== t.title) {
    const session = documents.acquire(to, 'retitle');
    try {
      await session.whenSettled();
      const text = session.getText();
      const next = retitleText(text, t.render(t.title), t.render(title));
      if (next !== text) await session.restoreText(next);
    } finally {
      documents.release(session, 'retitle');
    }
  }
  titled = { path: to, render: t.render, title };
}

/**
 * "New note" (DESIGN §6.15): the pending view (title focused, inside the tap) appears at once and
 * `POST /api/files {Untitled.md, onConflict: rename}` runs in the background. A title committed
 * before the POST returns becomes a rename; otherwise the typed title is handed to the note.
 * Content from a template (`TitledContent`) renders its `{{title}}` with the note's final name.
 */
export function createNote(folder: string, initialContent: string | Promise<string | TitledContent> = '', extension = 'md'): void {
  const id = ++pendingSeq;
  const key = newIdempotencyKey();
  const initialTitle = 'Untitled';
  startPendingNote(id, folder, initialTitle);
  useUi.getState().setDrawerOpen(false);
  void (async () => {
    let created: FileEntry;
    let render: TitledContent | null;
    try {
      // A template renders while the pending view is already up (its title focused in the tap).
      const loaded = await initialContent;
      render = typeof loaded === 'function' ? loaded : null;
      const content = render ? render(initialTitle) : (loaded as string);
      const result = await api.createFile({ path: joinPath(folder, `${initialTitle}.${extension}`), content, onConflict: 'rename' }, { idempotencyKey: key });
      applyWriteResult(queryClient, result, content);
      created = result.file;
    } catch (e) {
      clearPendingNote(id);
      toastError(e);
      return;
    }
    if (render) titled = { path: created.path, render, title: initialTitle };
    const pending = usePendingNote.getState().pending;
    if (!pending || pending.id !== id) {
      // The user went elsewhere; the note exists (as `Untitled 1`, say).
      void retitleNewNote(created.path, created.path);
      return;
    }
    const wanted = pending.title.trim();
    // An untouched title keeps the server's free name (`Untitled 1` when `Untitled` exists).
    if (pending.committed && wanted !== '' && wanted !== initialTitle && wanted !== created.basename) {
      let final = created.path;
      try {
        final = await renameEntry(created.path, wanted, 'file');
      } catch (e) {
        toastError(e);
      }
      await retitleNewNote(created.path, final);
      if (usePendingNote.getState().pending?.id !== id) return;
      clearPendingNote(id);
      // The title was committed (Enter, or a tap on the body area): writing continues in the note.
      requestNoteFocus();
      openPath(final, null, { newNote: true });
      return;
    }
    const { title, selectionStart, selectionEnd } = pending;
    usePendingNote.setState({
      pending: null,
      handoff: pending.committed ? null : { path: created.path, title, selectionStart, selectionEnd },
    });
    if (pending.committed) requestNoteFocus();
    openPath(created.path, null, { newNote: true });
    // The server's free name (`Untitled 1`); the inline title's rename retitles it again later.
    void retitleNewNote(created.path, created.path);
  })();
}

/**
 * Creates a note named exactly `name` (quick switcher); an existing note is opened instead. Focus
 * follows the rules of any other navigation from the switcher (DESIGN §6.19).
 */
export async function createNamedNote(name: string, fromPath: string | null, viaKeyboard: boolean): Promise<void> {
  const clean = name.trim().replace(/\.md$/i, '');
  const path = joinPath(newNoteFolder(fromPath), clean + '.md');
  const invalid = newPathError(path);
  if (invalid) {
    toast(invalid, { kind: 'error' });
    return;
  }
  try {
    const result = await api.createFile({ path, content: '', onConflict: 'fail' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, '');
    afterOpen(result.file.path, viaKeyboard);
    openPath(result.file.path, null, { newNote: true });
  } catch (e) {
    if (isProblem(e, 'already-exists') || isProblem(e, 'case-collision')) {
      const existing = e.problem.existingPath ?? path;
      afterOpen(existing, viaKeyboard);
      openPath(existing);
    } else toastError(e);
  }
}

// ---------- rename and move ----------

/** '1 note', '3 notes', or 'files' when task lists (or other indexed files) are among them. */
export function updatedFilesText(updates: ReadonlyArray<{ path: string }>): string {
  const n = updates.length;
  const notes = updates.every((u) => extensionOf(u.path) === 'md');
  return `${n} ${notes ? (n === 1 ? 'note' : 'notes') : n === 1 ? 'file' : 'files'}`;
}

function linkSummary(r: MoveResult): string {
  return r.linkUpdates.length === 0 ? '' : ` · updated links in ${updatedFilesText(r.linkUpdates)}`;
}

const FAILED_REASON: Record<string, string> = {
  'not-utf8': 'not valid UTF-8',
  'not-rewritable': 'a property link that cannot be rewritten',
  'span-mismatch': 'changed meanwhile',
  'io-error': 'storage error',
};

/** Why a move did not update the links in a file (MoveResult.failed), in words. */
export function failedReason(f: FailedUpdate): string {
  // A task list the server will not rewrite: not valid, or written by a newer version (API.md §20.9).
  if (f.reason === 'not-rewritable' && extensionOf(f.path) === 'tasks') return 'a task list that cannot be changed here; edit the links in its tasks';
  return FAILED_REASON[f.reason] ?? f.reason;
}

function reportFailures(r: MoveResult): void {
  if (r.failed.length === 0) return;
  const names = r.failed.map((f) => `${displayName(f.path)} (${failedReason(f)})`).join(', ');
  toast(`Links could not be updated in ${names}`, { kind: 'error', timeout: 8000 });
}

/** POST /api/move after flushing every dirty session (the server may rewrite links anywhere). */
export async function moveRequest(from: string, to: string, updateLinks?: boolean): Promise<MoveResult> {
  await documents.flushAll();
  const result = await api.move(updateLinks === undefined ? { from, to } : { from, to, updateLinks });
  applyMoveResult(syncTarget, result);
  return result;
}

/** The move dialog's preview: `POST /api/move {dryRun: true}` changes nothing. */
export function previewMove(from: string, to: string, updateLinks: boolean): Promise<MoveResult> {
  return api.move({ from, to, updateLinks, dryRun: true });
}

/** Renames in place, keeping the extension. Throws ApiError for the caller to show inline. */
export async function renameEntry(path: string, basename: string, type: 'file' | 'folder'): Promise<string> {
  const name = nameWithExtension(path, basename.trim(), type);
  if (name === lastSegment(path)) return path;
  const invalid = validateNewName(name);
  if (invalid) throw new Error(invalid);
  const result = await moveRequest(path, joinPath(folderOf(path), name));
  reportFailures(result);
  if (result.linkUpdates.length) toast(`Renamed${linkSummary(result)}`);
  return result.to;
}

/** Moves with a toast offering Undo (drag and drop, Move to…). */
export async function moveWithUndo(from: string, to: string, updateLinks?: boolean): Promise<MoveResult | null> {
  try {
    const result = await moveRequest(from, to, updateLinks);
    reportFailures(result);
    toast(`Moved ${displayName(from)}${linkSummary(result)}`, {
      action: { label: 'Undo', run: () => void undoMove(result) },
      timeout: 10_000,
    });
    return result;
  } catch (e) {
    toastError(e);
    return null;
  }
}

/**
 * Undo is a reverse move with link updating on: links resolve again, though their text follows the
 * current link format and collateral rewrites stay (DESIGN §6.15).
 */
async function undoMove(result: MoveResult): Promise<void> {
  try {
    const back = await moveRequest(result.to, result.from, true);
    reportFailures(back);
    toast(`Moved back${linkSummary(back)}`);
  } catch (e) {
    toastError(e);
  }
}

// ---------- delete ----------

/** Moves a file or folder to the trash (the caller confirms first). */
export async function deleteEntry(path: string, type: 'file' | 'folder'): Promise<void> {
  const affected = documents.all().filter((s) => isWithin(s.path, path));
  await Promise.all(affected.map((s) => s.flush()));
  let entry;
  try {
    entry = type === 'file' ? await api.deleteFile(path) : await api.deleteFolder(path);
  } catch (e) {
    toastError(e);
    return;
  }
  const current = activePath();
  if (current !== null && isWithin(current, path)) navigateTo('/', { replace: true });
  applyTrashEntry(syncTarget, entry);
  for (const s of affected) documents.close(s);
  forgetRecent(path);
  toast(`Moved ${displayName(path)} to the trash`, {
    action: {
      label: 'Undo',
      run: () =>
        void api
          .restoreTrash(entry.id)
          .then((r) => {
            applyRestoreResult(syncTarget, r);
            if (current !== null && isWithin(current, path)) openPath(rebasePath(current, path, r.path) ?? r.path);
          })
          .catch((e: unknown) => toastError(e)),
    },
    timeout: 10_000,
  });
}

// ---------- folders, links, downloads ----------

export async function createFolder(parent: string, name: string): Promise<string | null> {
  try {
    const result = await api.createFolder(joinPath(parent, name.trim()));
    applyFolderResult(syncTarget, result);
    if (parent) useUi.getState().setExpanded(parent, true);
    useUi.getState().revealInExplorer(result.folder.path);
    return result.folder.path;
  } catch (e) {
    toastError(e);
    return null;
  }
}

/** A link to `path` in the configured style, as the note `fromPath` would write it. */
export function linkTo(path: string, fromPath: string | null): string {
  const settings = currentSettings().files;
  const style = settings.useWikilinks ? 'wiki' : 'markdown';
  const text = linkText(path, fromPath ?? path, settings.newLinkFormat, style, currentTree().links);
  return assembleLink(text, style, path);
}

export async function copyLink(path: string, fromPath: string | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(linkTo(path, fromPath));
    toast('Link copied');
  } catch {
    toast('The browser refused clipboard access', { kind: 'error' });
  }
}

export function downloadFile(entry: Pick<FileEntry, 'path' | 'size' | 'mtime' | 'name'>): void {
  const a = document.createElement('a');
  a.href = api.rawUrl(entry, { download: true });
  a.download = entry.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Opens the trash entry's original location after a restore from the Trash page. */
export function openRestored(path: string, type: 'file' | 'folder'): void {
  if (type === 'file') navigateTo(noteRoute(path));
  else useUi.getState().revealInExplorer(path);
}
