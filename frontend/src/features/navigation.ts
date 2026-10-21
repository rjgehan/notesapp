// App-level navigation usable outside React (editor extensions, sessions, commands).
// `NavigationBridge` (inside the router) registers react-router's navigate function.
import { isProblem } from '../api/client';
import { api } from '../api/endpoints';
import { currentSettings, currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { newIdempotencyKey } from '../state/clientId';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
import { applyWriteResult } from '../sync/treePatch';
import { folderTemplateOutput, placeTemplateCursor } from './folderTemplates';
import { createPath, resolve } from './links';
import { noteRoute, pathFromLocation } from './paths';
import { toastError } from './errors';

type Navigate = (to: string, opts?: { replace?: boolean }) => void;

let navigateFn: Navigate = (to, opts) => {
  if (opts?.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
};

export function setNavigator(fn: Navigate): void {
  navigateFn = fn;
}

export function navigateTo(to: string, opts?: { replace?: boolean }): void {
  navigateFn(to, opts);
}

/** The vault path of the open note, from the current location. */
export function activePath(): string | null {
  return pathFromLocation(window.location.pathname);
}

/**
 * Opens a file. `newNote`: this tab has just created it, so it shows the editor whatever the
 * mode of other notes (the new-note flow types its body right away, DESIGN §6.15).
 */
export function openPath(path: string, subpath?: string | null, opts?: { replace?: boolean; newNote?: boolean }): void {
  if (opts?.newNote) useUi.getState().setEditingNew(path);
  navigateTo(noteRoute(path, subpath), opts?.replace ? { replace: true } : undefined);
  useUi.getState().setDrawerOpen(false);
}

/**
 * Follows a link target as written in `source` (DESIGN §6.6 "Opening links"): resolve on the
 * client; otherwise create the note at `createPath` (409 already-exists counts as success).
 */
export async function openLink(target: string, subpath: string | null, source: string): Promise<void> {
  const tree = currentTree();
  const resolved = resolve(target, source, tree.links);
  if (import.meta.env.DEV) void checkResolutionParity(target, source, resolved);
  if (resolved) {
    openPath(resolved, subpath);
    return;
  }
  const path = createPath(target, source, currentSettings().files);
  if (!path) {
    toast("Can't create a note for this link", { kind: 'error' });
    return;
  }
  try {
    // The new note gets its folder's template (ROADMAP item 30); cancelling its questions creates nothing.
    const out = await folderTemplateOutput(path);
    if (!out) return;
    const result = await api.createFile({ path, content: out.text, onConflict: 'fail' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, out.text);
    openPath(result.file.path, subpath, { newNote: true });
    void placeTemplateCursor(result.file.path, out);
  } catch (e) {
    if (isProblem(e, 'already-exists') || isProblem(e, 'case-collision')) {
      openPath(e.problem.existingPath ?? path, subpath);
      return;
    }
    toastError(e);
  }
}

/**
 * Opens search with `query`: the search page on phones (`/search?q=`), otherwise the search panel,
 * whose query lives in zustand so the open note never changes (DESIGN §6.4).
 */
export function openSearch(query: string): void {
  const ui = useUi.getState();
  if (window.matchMedia?.('(max-width: 767px)').matches) {
    ui.setDrawerOpen(false);
    navigateTo('/search' + (query ? '?q=' + encodeURIComponent(query) : ''));
    return;
  }
  ui.setSearchQuery(query);
  ui.setLeftTab('search');
  if (window.matchMedia?.('(min-width: 1200px)').matches) ui.setLeftOpen(true);
  else ui.setDrawerOpen(true);
}

/** Opens search for a tag (`tag:#tag`). */
export function openTag(tag: string): void {
  openSearch(`tag:#${tag}`);
}

/**
 * Development builds compare the client resolver with POST /api/links/resolve for every followed
 * link and log mismatches (DESIGN §6.6 parity check). Production builds never call the endpoint.
 */
async function checkResolutionParity(target: string, source: string, clientPath: string | null): Promise<void> {
  try {
    const { resolved } = await api.resolveLinks({ source, targets: [target] });
    const server = resolved[target];
    const clientCreate = clientPath === null ? createPath(target, source, currentSettings().files) : null;
    if (server && (server.path !== clientPath || server.createPath !== clientCreate)) {
      console.warn('[notesapp] link resolution differs from the server', { target, source, client: { path: clientPath, createPath: clientCreate }, server });
    }
  } catch {
    // The parity check is diagnostic only.
  }
}
