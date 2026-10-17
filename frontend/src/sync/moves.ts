// Client move map (DESIGN §6.10): `from → to` for every move this page learned about, from its
// own MoveResults and from entry.moved events. A save that finds its path gone (409 with
// currentVersion null and no movedTo) consults it before declaring the note deleted.
//
// A file created later at a moved-away path is a different note: the entry for that path is
// dropped, and the path is remembered as re-created so that a server `movedTo` for it, which
// may predate the creation, is not followed either (it would send the new note's save onto an
// unrelated note).
import { rebasePath } from '../features/paths';

export class MoveMap {
  /** lower(from) → to, for files and folders. Chained, so a later move updates earlier entries. */
  private readonly map = new Map<string, { to: string; type: 'file' | 'folder' }>();
  /** lower(path) of files created after a move away from that path. */
  private readonly recreated = new Set<string>();

  record(from: string, to: string, type: 'file' | 'folder'): void {
    for (const [key, entry] of this.map) {
      const next = rebasePath(entry.to, from, to);
      if (next !== null) this.map.set(key, { ...entry, to: next });
    }
    const lower = from.toLowerCase();
    this.map.set(lower, { to, type });
    this.recreated.delete(lower);
    // The moved file lives at `to` now, whatever was created there before.
    this.recreated.delete(to.toLowerCase());
  }

  /**
   * A file was created at `path` (file.created, an own create, a restore): moves recorded away
   * from it no longer describe the file there.
   */
  created(path: string): void {
    const lower = path.toLowerCase();
    if (this.map.delete(lower) || this.lookup(path) !== null) this.recreated.add(lower);
  }

  /** False when `path` was re-created after a move away from it (the server's movedTo may be stale). */
  trustsMoveFrom(path: string): boolean {
    return !this.recreated.has(path.toLowerCase());
  }

  /** Where `path` lives now, or null when no recorded move covers it. */
  lookup(path: string): string | null {
    const lower = path.toLowerCase();
    if (this.recreated.has(lower)) return null;
    const direct = this.map.get(lower);
    if (direct) return direct.to;
    let best: { from: string; to: string } | null = null;
    for (const [from, entry] of this.map) {
      if (entry.type !== 'folder' || !lower.startsWith(from + '/')) continue;
      if (!best || from.length > best.from.length) best = { from, to: entry.to };
    }
    return best ? best.to + path.slice(best.from.length) : null;
  }
}
