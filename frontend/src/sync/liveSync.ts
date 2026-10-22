// The page's live sync wiring: the event stream over the real (or mock) endpoints, and the
// cache target shared by SSE events and this tab's own mutation responses.
import { isTransient } from '../api/client';
import { EventStream } from '../api/events';
import { api } from '../api/endpoints';
import { currentSettings, refetchTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import { dispatchExtensionEvent, eventHandlerNames, onExtensionsChanged } from '../extensions';
import { prefetchBookmarks } from '../features/bookmarkStore';
import { announceOrphanDrafts } from '../features/draftRecovery';
import { activePath, openPath } from '../features/navigation';
import { rebasePath } from '../features/paths';
import { renameRecent } from '../features/recent';
import { reportServerBuild } from '../state/buildCheck';
import { clientId } from '../state/clientId';
import { reportStreamHealth } from '../state/connection';
import { cachedTree, noteWritten } from '../offline/offlineStore';
import { startOfflineSync, treeLoadedFromServer, treeLoadedFromSnapshot } from '../offline/offlineSync';
import { useUi } from '../state/ui';
import { rebaseWorkspace } from '../workspace/store';
import { applyEvent, type SyncTarget } from './applyEvents';
import { documents, draftStore, moveMap, tabs } from './instance';
import { applyWriteResult } from './treePatch';

export const syncTarget: SyncTarget = {
  qc: queryClient,
  documents,
  moves: moveMap,
  drafts: draftStore,
  settings: currentSettings,
  onEntryMoved(from, to, type) {
    renameRecent(from, to);
    // Every tab showing the file (or a file in the folder) follows it (DESIGN §6.40).
    rebaseWorkspace(from, to, type);
    if (type === 'folder') useUi.getState().rekeyExpanded(from, to);
    useUi.getState().rekeyNoteModes(from, to);
    const current = activePath();
    const next = current === null ? null : type === 'file' ? (current === from ? to : null) : rebasePath(current, from, to);
    // A remote move of the open note replaces the stale URL (DESIGN §6.4).
    if (next !== null && next !== current) openPath(next, null, { replace: true });
  },
  onDraftFailure() {
    useUi.getState().setDraftsFailing(true);
  },
};

export const eventStream = new EventStream({
  clientId,
  open: (id, lastEventId) => api.openEvents(id, lastEventId),
  apply(name, data, id) {
    applyEvent(syncTarget, name, data);
    dispatchExtensionEvent(name, data, id);
  },
  refetchTree: async () => {
    const tree = await refetchTree();
    treeLoadedFromServer();
    return tree.eventId;
  },
  invalidateAll: () => {
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tree' });
  },
  revalidateDocuments: () => documents.revalidateAll(),
  retryQueued: () => documents.retryAll(),
  onBuild: (sha) => reportServerBuild(sha),
  onHealth: reportStreamHealth,
  onCaughtUp: (caughtUp) => useUi.getState().setCaughtUp(caughtUp),
  extensionNames: eventHandlerNames,
  onExtensionsChanged,
});

/** A tree request still unanswered after this long shows the device's snapshot meanwhile. */
const SNAPSHOT_AFTER_MS = 2500;

/**
 * Startup order (DESIGN §6.3): the tree's `eventId` first, then the stream resumes from it. When
 * the server is unreachable, the device's tree snapshot (DESIGN §6.26) lets recently opened notes
 * open offline; the stream then starts without an id, so its `hello` asks for a resync, which
 * fetches the real tree and revalidates every open note once the server is back.
 */
export async function startLiveSync(): Promise<void> {
  startOfflineSync({
    documents,
    moves: moveMap,
    drafts: draftStore,
    clientId,
    liveOwners: (path) => tabs.liveOwners(path),
    readFile: (path) => api.readFile(path),
    saveFile: (path, req) => api.saveFile(path, req),
    onSaved: (result, content) => {
      applyWriteResult(queryClient, result, content);
      noteWritten(result, content);
    },
  });
  // The tree request retries transient failures for a while (and waits while the device is
  // offline): the snapshot stands in once it is clear the answer will take time.
  const showSnapshot = async () => {
    if (queryClient.getQueryData(queryKeys.tree())) return;
    const snapshot = await cachedTree();
    if (snapshot && !queryClient.getQueryData(queryKeys.tree())) {
      queryClient.setQueryData(queryKeys.tree(), snapshot.tree);
      treeLoadedFromSnapshot(snapshot.at);
    }
  };
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const snapshotTimer = setTimeout(() => void showSnapshot(), offline ? 0 : SNAPSHOT_AFTER_MS);
  let eventId: string | null = null;
  try {
    eventId = (await refetchTree()).eventId;
    treeLoadedFromServer();
  } catch (e) {
    // Unreachable for now: hello will ask for a resync once the stream connects.
    if (isTransient(e)) await showSnapshot();
  } finally {
    clearTimeout(snapshotTimer);
  }
  eventStream.start(eventId);
  // Commands and menus tell what is bookmarked from the cache (DESIGN §6.23).
  prefetchBookmarks();
  // Drafts of notes renamed or deleted while no tab was open can only be found against the tree.
  if (eventId !== null) void announceOrphanDrafts();
}
