// The page's document registry, wired to the real API, IndexedDB drafts and the UI stores.
import { api } from '../api/endpoints';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { activePath, openPath } from '../features/navigation';
import { noteWritten, openNote } from '../offline/offlineStore';
import { renameRecent } from '../features/recent';
import { setUnsavedProbe } from '../state/buildCheck';
import { clientId } from '../state/clientId';
import { toast } from '../state/toasts';
import { vaultKey } from '../state/vault';
import { useUi } from '../state/ui';
import { viewFor } from '../views/registry';
import { DocumentRegistry } from './documents';
import { IdbDraftStore, TabCoordinator, type DraftStore } from './drafts';
import { MoveMap } from './moves';
import { setCreatedListener } from './treePatch';

/** IndexedDB may be missing (old private modes); drafts then fail loudly instead of silently. */
class UnavailableDraftStore implements DraftStore {
  private fail(): Promise<never> {
    return Promise.reject(new Error('IndexedDB is not available'));
  }
  put = () => this.fail();
  remove = () => this.fail();
  listForPath = () => this.fail();
  listAll = () => this.fail();
  rekey = () => this.fail();
  discard = () => this.fail();
  takeDiscarded = () => this.fail();
  listDiscarded = () => this.fail();
  prune = () => this.fail();
}

export const draftStore: DraftStore = typeof indexedDB === 'undefined' ? new UnavailableDraftStore() : new IdbDraftStore(indexedDB, vaultKey('notesapp'));

export const moveMap = new MoveMap();
// Files this tab creates (own WriteResults) end the moves recorded away from their paths.
setCreatedListener((path) => moveMap.created(path));

let registry: DocumentRegistry | null = null;

export const tabs = new TabCoordinator(clientId, (path) => registry?.ownsDraft(path) ?? false);

registry = new DocumentRegistry({
  api,
  // Offline mode (DESIGN §6.26): a note opens from the device's copy when the server is unreachable.
  loadFile: openNote,
  onSaved: noteWritten,
  drafts: draftStore,
  moves: moveMap,
  clientId,
  queryClient,
  tabs,
  treeEntry: (path) => currentTree().byPath.get(path),
  notify: (n) => toast(n.message, { action: n.action }),
  onDraftWrite: (ok) => {
    if (useUi.getState().draftsFailing !== !ok) useUi.getState().setDraftsFailing(!ok);
  },
  onSummary: (summary) => useUi.getState().setSaveSummary(summary),
  onSessionMoved: (from, to) => {
    renameRecent(from, to);
    if (activePath() === from) openPath(to, null, { replace: true });
  },
  caughtUp: () => useUi.getState().caughtUp,
  // Conflicts on files whose view merges semantically (drawings, sheets) resolve without the banner.
  mergeFor: (path) => {
    const entry = currentTree().byPath.get(path);
    if (!entry) return undefined;
    try {
      return viewFor(entry).merge;
    } catch {
      return undefined;
    }
  },
});

export const documents: DocumentRegistry = registry;

setUnsavedProbe(() => documents.anyUnsaved());

void draftStore.prune().catch(() => undefined);
