// The page's live sync wiring: the event stream over the real (or mock) endpoints, and the
// cache target shared by SSE events and this tab's own mutation responses.
import { EventStream } from '../api/events';
import { api } from '../api/endpoints';
import { currentSettings, refetchTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { dispatchExtensionEvent, eventHandlerNames, onExtensionsChanged } from '../extensions';
import { announceOrphanDrafts } from '../features/draftRecovery';
import { activePath, openPath } from '../features/navigation';
import { rebasePath } from '../features/paths';
import { renameRecent } from '../features/recent';
import { reportServerBuild } from '../state/buildCheck';
import { clientId } from '../state/clientId';
import { reportStreamHealth } from '../state/connection';
import { useUi } from '../state/ui';
import { applyEvent, type SyncTarget } from './applyEvents';
import { documents, draftStore, moveMap } from './instance';

export const syncTarget: SyncTarget = {
  qc: queryClient,
  documents,
  moves: moveMap,
  drafts: draftStore,
  settings: currentSettings,
  onEntryMoved(from, to, type) {
    renameRecent(from, to);
    if (type === 'folder') useUi.getState().rekeyExpanded(from, to);
    const editing = useUi.getState().editingNew;
    const editingNext = editing === null ? null : type === 'file' ? (editing === from ? to : null) : rebasePath(editing, from, to);
    if (editingNext !== null) useUi.getState().setEditingNew(editingNext);
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
  refetchTree: async () => (await refetchTree()).eventId,
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

/** Startup order (DESIGN §6.3): the tree's `eventId` first, then the stream resumes from it. */
export async function startLiveSync(): Promise<void> {
  let eventId: string | null = null;
  try {
    eventId = (await refetchTree()).eventId;
  } catch {
    // Unreachable for now: hello will ask for a resync once the stream connects.
  }
  eventStream.start(eventId);
  // Drafts of notes renamed or deleted while no tab was open can only be found against the tree.
  if (eventId !== null) void announceOrphanDrafts();
}
