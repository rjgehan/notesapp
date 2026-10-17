// The page's document registry, wired to the real API, IndexedDB drafts and the UI stores.
import { api } from '../api/endpoints';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { activePath, openPath } from '../features/navigation';
import { renameRecent } from '../features/recent';
import { setUnsavedProbe } from '../state/buildCheck';
import { clientId } from '../state/clientId';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
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

export const draftStore: DraftStore = typeof indexedDB === 'undefined' ? new UnavailableDraftStore() : new IdbDraftStore();

export const moveMap = new MoveMap();
// Files this tab creates (own WriteResults) end the moves recorded away from their paths.
setCreatedListener((path) => moveMap.created(path));

let registry: DocumentRegistry | null = null;

export const tabs = new TabCoordinator(clientId, (path) => registry?.ownsDraft(path) ?? false);

registry = new DocumentRegistry({
  api,
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
});

export const documents: DocumentRegistry = registry;

setUnsavedProbe(() => documents.anyUnsaved());

void draftStore.prune().catch(() => undefined);
