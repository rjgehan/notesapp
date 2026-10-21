// Replays edits made offline in tabs that are gone (DESIGN §6.26). A tab that is still open saves
// its own edits: its sessions retry once the event stream has caught up (§6.9). But iOS often
// kills an installed app in the background, and a closed tab leaves its unsaved text only in its
// drafts (§6.9). Those drafts are the offline save queue: each holds the text and the version it
// was based on.
//
// When the connection is back, the newest draft of each note that no live tab owns is saved with
// its own base version, so the server's version check decides (API.md §4):
// - the base is still current: `PUT {content, baseVersion}` → 200, the draft goes;
// - the note changed since (another device, or the base was already stale offline): nothing is
//   written; the note is listed for review, and opening it shows the ordinary conflict banner
//   with the draft as "mine" (§6.10). A queued save never silently overwrites;
// - equal text is never a conflict: the draft is dropped (its save had gone through already).
import { isProblem, isTransient, isVersionConflict, isStorageProblem } from '../api/client';
import type { FileEntry, SaveFileRequest, TextFile, WriteResult } from '../api/types';
import { fromLf, toLf } from '../features/eol';
import type { DraftRecord, DraftStore } from '../sync/drafts';

export interface DraftReplayDeps {
  drafts: Pick<DraftStore, 'listAll' | 'remove' | 'discard'>;
  clientId: string;
  /** Client ids of other live tabs owning drafts for a path. */
  liveOwners(path: string): Promise<Set<string>>;
  treeEntry(path: string): FileEntry | undefined;
  /** This tab has a session for the path: it restores and saves the drafts itself on open. */
  hasSession(path: string): boolean;
  readFile(path: string): Promise<TextFile>;
  saveFile(path: string, req: SaveFileRequest): Promise<WriteResult>;
  /** Own-mutation cache patches for a replayed save (DESIGN §6.3); `content` as sent. */
  onSaved(result: WriteResult, content: string): void;
}

export interface ReplayReport {
  /** Saved now. */
  synced: string[];
  /** The server's copy changed since the draft's base: open the note to resolve the conflict. */
  review: string[];
  /** The server could not be reached; the rest waits for the next attempt. */
  interrupted: boolean;
}

/** Drafts grouped by path, newest first. */
function byPath(drafts: readonly DraftRecord[]): Map<string, DraftRecord[]> {
  const map = new Map<string, DraftRecord[]>();
  for (const d of drafts) {
    const list = map.get(d.path) ?? [];
    list.push(d);
    map.set(d.path, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.at - a.at);
  return map;
}

export async function replayOrphanDrafts(deps: DraftReplayDeps): Promise<ReplayReport> {
  const report: ReplayReport = { synced: [], review: [], interrupted: false };
  const all = (await deps.drafts.listAll()).filter((d) => d.clientId !== deps.clientId);
  for (const [path, drafts] of byPath(all)) {
    const entry = deps.treeEntry(path);
    // A path that is gone is an orphaned draft (renamed or deleted note): recovered elsewhere.
    if (!entry || deps.hasSession(path)) continue;
    const live = await deps.liveOwners(path);
    const orphans = drafts.filter((d) => !live.has(d.clientId));
    if (orphans.length === 0) continue;
    const [newest, ...older] = orphans;
    const outcome = await replayOne(deps, newest, entry);
    if (outcome === 'interrupted') {
      report.interrupted = true;
      return report;
    }
    if (outcome === 'review') {
      report.review.push(path);
      continue;
    }
    // Saved, or already on the server: older drafts of the note must not come back over it.
    for (const d of older) {
      await deps.drafts.discard({ path: d.path, text: d.text, eol: d.eol, at: d.at, reason: 'superseded-draft' }).catch(() => undefined);
      await deps.drafts.remove(d.path, d.clientId).catch(() => undefined);
    }
    if (outcome === 'synced') report.synced.push(path);
  }
  return report;
}

type Outcome = 'synced' | 'dropped' | 'review' | 'skip' | 'interrupted';

async function replayOne(deps: DraftReplayDeps, d: DraftRecord, entry: FileEntry): Promise<Outcome> {
  const drop = async (): Promise<Outcome> => {
    await deps.drafts.remove(d.path, d.clientId).catch(() => undefined);
    return 'dropped';
  };
  if (d.conflict || d.baseVersion === null || d.baseVersion !== entry.version) {
    // Not based on the server's current version (or a Keep mine still pending): only the
    // conflict banner may decide. A draft whose text already is the server's is just dropped.
    try {
      const file = await deps.readFile(d.path);
      if (toLf(file.content) === d.text) return drop();
    } catch (e) {
      if (isTransient(e)) return 'interrupted';
    }
    return 'review';
  }
  const content = fromLf(d.text, d.eol);
  try {
    const result = await deps.saveFile(d.path, { content, baseVersion: d.baseVersion });
    deps.onSaved(result, content);
    await deps.drafts.remove(d.path, d.clientId).catch(() => undefined);
    return 'synced';
  } catch (e) {
    if (isTransient(e) || isStorageProblem(e)) return 'interrupted';
    if (isVersionConflict(e)) {
      const theirs = e.problem.currentContent;
      if (theirs !== null && toLf(theirs) === d.text) return drop();
      // Deleted or moved meanwhile: left for the orphaned-draft recovery.
      return theirs === null ? 'skip' : 'review';
    }
    if (isProblem(e, 'not-found')) return 'skip';
    return 'review';
  }
}
