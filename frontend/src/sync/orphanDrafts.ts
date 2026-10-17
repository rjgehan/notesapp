// Drafts nobody can restore any more (DESIGN §6.9 "a draft is never orphaned"). Drafts are
// restored when their exact path is opened, and re-keyed by live tabs that see a move. A note
// renamed, moved (a folder rename included) or deleted while no tab of this browser was open
// leaves its drafts under a path that no longer exists: they are found here, after the tree has
// loaded, and offered for recovery (Settings › This device, and the note's "not found" page).
import type { Version } from '../api/types';
import { DRAFT_MAX_AGE_MS, type DraftRecord, type DraftStore } from './drafts';

export interface OrphanDraft extends DraftRecord {
  /**
   * The note this draft most likely belongs to now: the only file whose version equals the
   * draft's base (a pure move keeps the blob id). Null when unknown or ambiguous.
   */
  likelyPath: string | null;
}

export interface OrphanScan {
  drafts: Pick<DraftStore, 'listAll'>;
  /** This tab's client id: its own drafts are not orphans. */
  clientId: string;
  /** The tree's files by path. */
  files: ReadonlyMap<string, { version: Version | null }>;
  /** Client ids of other live tabs owning drafts for a path. */
  liveOwners(path: string): Promise<Set<string>>;
  now?: number;
}

/** Drafts whose path is not in the tree, owned by no live tab, newest first. */
export async function findOrphanDrafts(scan: OrphanScan): Promise<OrphanDraft[]> {
  const now = scan.now ?? Date.now();
  const all = await scan.drafts.listAll();
  const candidates = all.filter((d) => d.clientId !== scan.clientId && !scan.files.has(d.path) && now - d.at <= DRAFT_MAX_AGE_MS);
  if (candidates.length === 0) return [];
  const paths = [...new Set(candidates.map((d) => d.path))];
  const live = new Map(await Promise.all(paths.map(async (p) => [p, await scan.liveOwners(p)] as const)));
  const byVersion = new Map<string, string[]>();
  for (const [path, f] of scan.files) {
    if (f.version) byVersion.set(f.version, [...(byVersion.get(f.version) ?? []), path]);
  }
  return candidates
    .filter((d) => !live.get(d.path)?.has(d.clientId))
    .sort((a, b) => b.at - a.at)
    .map((d) => {
      const same = d.baseVersion ? (byVersion.get(d.baseVersion) ?? []) : [];
      return { ...d, likelyPath: same.length === 1 ? same[0] : null };
    });
}
