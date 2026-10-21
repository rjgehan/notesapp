// Offline mode upkeep (DESIGN §6.21), started with live sync:
// - the tree snapshot follows the server's tree (debounced; never while the app shows the snapshot);
// - once the event stream has caught up: sessions opened from an offline copy revalidate, copies
//   of moved, deleted or changed notes follow the tree, and edits made offline in tabs that are
//   gone are replayed (offline/draftReplay.ts), in that order.
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { TreeResponse, WriteResult } from '../api/types';
import { displayName } from '../features/paths';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
import type { DocumentRegistry } from '../sync/documents';
import type { DraftStore } from '../sync/drafts';
import type { MoveMap } from '../sync/moves';
import { replayOrphanDrafts, type DraftReplayDeps } from './draftReplay';
import { planMaintenance } from './noteCache';
import { noteCache, offlineCopiesEnabled, refreshCopy, saveTreeSnapshot, useOffline } from './offlineStore';

const TREE_SAVE_DEBOUNCE_MS = 15_000;
const CATCH_UP_DELAY_MS = 1500;

export interface OfflineSyncDeps {
  documents: Pick<DocumentRegistry, 'get'>;
  moves: Pick<MoveMap, 'lookup'>;
  drafts: DraftStore;
  clientId: string;
  liveOwners(path: string): Promise<Set<string>>;
  readFile: DraftReplayDeps['readFile'];
  saveFile: DraftReplayDeps['saveFile'];
  onSaved(result: WriteResult, content: string): void;
}

let treeFromServer = false;
let treeTimer: ReturnType<typeof setTimeout> | null = null;

function saveTree(): void {
  if (treeTimer) clearTimeout(treeTimer);
  treeTimer = null;
  const tree = queryClient.getQueryData<TreeResponse>(queryKeys.tree());
  if (tree && treeFromServer) saveTreeSnapshot(tree);
}

function scheduleTreeSave(): void {
  if (treeFromServer && !treeTimer) treeTimer = setTimeout(saveTree, TREE_SAVE_DEBOUNCE_MS);
}

/** A tree arrived from the server (startup, resync): the snapshot follows it again. */
export function treeLoadedFromServer(): void {
  treeFromServer = true;
  useOffline.getState().setTreeSnapshotAt(null);
  scheduleTreeSave();
}

/** The app started on the device's snapshot (the server was unreachable). */
export function treeLoadedFromSnapshot(at: number): void {
  treeFromServer = false;
  useOffline.getState().setTreeSnapshotAt(at);
}

let started = false;
let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;

export function startOfflineSync(deps: OfflineSyncDeps): void {
  if (started) return;
  started = true;

  // ---------- the tree snapshot ----------
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.query.queryKey[0] === 'tree') scheduleTreeSave();
  });
  // iOS may kill a hidden app without warning: write what is pending.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && treeTimer) saveTree();
  });

  // ---------- after the stream catches up ----------
  useUi.subscribe((state, prev) => {
    if (state.caughtUp && !prev.caughtUp) scheduleCatchUp(deps);
  });
  if (useUi.getState().caughtUp) scheduleCatchUp(deps);
}

function scheduleCatchUp(deps: OfflineSyncDeps): void {
  if (catchUpTimer) clearTimeout(catchUpTimer);
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    running ??= afterCatchUp(deps).finally(() => {
      running = null;
    });
  }, CATCH_UP_DELAY_MS);
}

/** Runs once the server is reachable and the tree is current again. */
export async function afterCatchUp(deps: OfflineSyncDeps): Promise<void> {
  if (!useUi.getState().caughtUp || !treeFromServer) return;
  revalidateOfflineSessions(deps);
  await maintainCopies(deps).catch(() => undefined);
  await replayDrafts(deps).catch(() => undefined);
}

/** Sessions opened from a copy compare it with the server's version (a stale copy may conflict). */
function revalidateOfflineSessions(deps: OfflineSyncDeps): void {
  const served = Object.keys(useOffline.getState().servedOffline);
  if (served.length === 0) return;
  const tree = currentTree();
  for (const path of served) void deps.documents.get(path)?.revalidate(tree.byPath.get(path)?.version ?? undefined);
  useOffline.getState().clearServed();
}

async function maintainCopies(deps: OfflineSyncDeps): Promise<void> {
  if (!offlineCopiesEnabled()) return;
  const plan = planMaintenance(await noteCache.index(), currentTree().byPath, (p) => deps.moves.lookup(p));
  for (const path of plan.remove) await noteCache.remove(path);
  for (const [from, to] of plan.rekey) await noteCache.rekey(from, to);
  for (const path of plan.refresh) {
    if (!useUi.getState().caughtUp) return;
    await refreshCopy(path).catch(() => undefined);
  }
}

async function replayDrafts(deps: OfflineSyncDeps): Promise<void> {
  const replay = () =>
    replayOrphanDrafts({
      drafts: deps.drafts,
      clientId: deps.clientId,
      liveOwners: deps.liveOwners,
      treeEntry: (path) => currentTree().byPath.get(path),
      hasSession: (path) => deps.documents.get(path) !== undefined,
      readFile: deps.readFile,
      saveFile: deps.saveFile,
      onSaved: deps.onSaved,
    });
  // One tab at a time replays (two would only repeat idempotent saves, but toast twice).
  const report = typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request('notesapp-draft-replay', replay) : await replay();
  useOffline.getState().setReview(report.review);
  if (report.synced.length > 0) {
    toast(report.synced.length === 1 ? `Synced your offline edits to ${displayName(report.synced[0])}` : `Synced your offline edits to ${report.synced.length} notes`);
  }
}
