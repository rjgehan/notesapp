// Recovery of orphaned drafts (DESIGN §6.9): drafts left under a path that no longer exists,
// because the note was renamed, moved or deleted while no tab of this browser was open.
import { api } from '../api/endpoints';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import { clientId, newIdempotencyKey } from '../state/clientId';
import { toast } from '../state/toasts';
import { orphanRecord, type DraftRecord } from '../sync/drafts';
import { documents, draftStore, tabs } from '../sync/instance';
import { findOrphanDrafts, type OrphanDraft } from '../sync/orphanDrafts';
import { applyWriteResult } from '../sync/treePatch';
import { fromLf } from './eol';
import { navigateTo, openPath } from './navigation';
import { displayName } from './paths';
import { toastError } from './errors';

/** Orphaned drafts against the current tree (empty before the tree has loaded). */
export function listOrphanDrafts(): Promise<OrphanDraft[]> {
  if (!queryClient.getQueryData(queryKeys.tree())) return Promise.resolve([]);
  const tree = currentTree();
  return findOrphanDrafts({ drafts: draftStore, clientId, files: tree.byPath, liveOwners: (p) => tabs.liveOwners(p) });
}

/** Drafts for `path` (which is not in the vault) that no live tab owns. */
export async function orphanDraftsFor(path: string): Promise<OrphanDraft[]> {
  const all = await listOrphanDrafts();
  return all.filter((d) => d.path === path);
}

/** After startup: tell the user about unsaved text that no note can restore any more. */
export async function announceOrphanDrafts(): Promise<void> {
  let found: OrphanDraft[];
  try {
    found = await listOrphanDrafts();
  } catch {
    return;
  }
  if (found.length === 0) return;
  toast(
    found.length === 1
      ? `Unsaved text of ${displayName(found[0].path)} (renamed or deleted since) is kept on this device`
      : `Unsaved text of ${found.length} renamed or deleted notes is kept on this device`,
    { action: { label: 'Review', run: () => navigateTo('/settings/device') }, timeout: 15_000 },
  );
}

async function dropDraft(d: DraftRecord): Promise<void> {
  await draftStore.remove(d.path, d.clientId).catch(() => undefined);
}

/** Creates a note at the draft's path with its text (another free name if it is taken). */
export async function recreateFromDraft(d: DraftRecord): Promise<boolean> {
  const content = fromLf(d.text, d.eol);
  try {
    const result = await api.createFile({ path: d.path, content, onConflict: 'rename' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, content);
    await dropDraft(d);
    toast(`Recreated ${displayName(result.file.path)} with your text`);
    openPath(result.file.path);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** Puts the draft's text into the note at `path` as an ordinary, undoable edit. */
export async function restoreDraftInto(d: DraftRecord, path: string): Promise<boolean> {
  openPath(path);
  const session = documents.acquire(path, 'draft-recovery');
  try {
    await session.whenSettled();
    if (session.hasUnsavedChanges()) {
      toast(`${displayName(path)} has unsaved changes; save them first`, { kind: 'error' });
      return false;
    }
    if (!(await session.restoreText(d.text))) {
      toast(`${displayName(path)} cannot be edited right now; try again when it is open`, { kind: 'error' });
      return false;
    }
    await dropDraft(d);
    toast(`Restored your unsaved text into ${displayName(path)}`);
    return true;
  } finally {
    documents.release(session, 'draft-recovery');
  }
}

/** Forgets the draft; its text stays in the discarded store for 7 days. */
export async function forgetDraft(d: DraftRecord): Promise<void> {
  await draftStore.discard(orphanRecord(d)).catch(() => undefined);
  await dropDraft(d);
}
