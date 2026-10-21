// Recently opened files, per device (localStorage): the Recent files pane, the quick switcher's
// empty state and `[[` completion (DESIGN §6.23). Each entry keeps when it was last opened; the
// list follows renames and moves, and drops files deleted through the app. Other tabs of this
// browser see changes through the `storage` event.
import { useSyncExternalStore } from 'react';

export interface RecentEntry {
  path: string;
  /** When it was last opened, epoch milliseconds (0 for entries kept from before times were stored). */
  at: number;
}

const KEY = 'notesapp:recentFiles';
/** The first format: paths only, newest first. Read once and moved to KEY. */
const LEGACY_KEY = 'notesapp:recent';
const LAST_PATH_KEY = 'notesapp:lastPath';
export const MAX_RECENT = 50;

const listeners = new Set<() => void>();
let cache: RecentEntry[] | null = null;
let raw: string | null = null;

function parse(text: string | null): RecentEntry[] {
  try {
    const list: unknown = text ? JSON.parse(text) : [];
    if (!Array.isArray(list)) return [];
    const out: RecentEntry[] = [];
    const seen = new Set<string>();
    for (const x of list) {
      const entry =
        typeof x === 'string' ? { path: x, at: 0 } : x && typeof x === 'object' && typeof (x as RecentEntry).path === 'string' ? { path: (x as RecentEntry).path, at: Number((x as RecentEntry).at) || 0 } : null;
      if (entry && !seen.has(entry.path)) {
        seen.add(entry.path);
        out.push(entry);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function read(): RecentEntry[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(KEY);
    if (text === null) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        text = JSON.stringify(parse(legacy));
        localStorage.setItem(KEY, text);
        localStorage.removeItem(LEGACY_KEY);
      }
    }
  } catch {
    // Private mode: recents are a convenience only.
  }
  if (cache === null || text !== raw) {
    raw = text;
    cache = parse(text);
  }
  return cache;
}

function write(list: RecentEntry[]): void {
  const next = list.slice(0, MAX_RECENT);
  const text = JSON.stringify(next);
  cache = next;
  raw = text;
  try {
    localStorage.setItem(KEY, text);
  } catch {
    // Private mode: kept in memory for this page only.
  }
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = null;
    for (const l of listeners) l();
  });
}

export function subscribeRecent(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Newest first. */
export function recentEntries(): RecentEntry[] {
  return read();
}

export function recentPaths(): string[] {
  return read().map((e) => e.path);
}

/** The recent files, re-rendering when they change (here or in another tab). */
export function useRecentEntries(): RecentEntry[] {
  return useSyncExternalStore(subscribeRecent, read);
}

export function recordOpened(path: string, now = Date.now()): void {
  write([{ path, at: now }, ...read().filter((e) => e.path !== path)]);
  try {
    localStorage.setItem(LAST_PATH_KEY, path);
  } catch {
    // ignore
  }
}

export function lastOpenedPath(): string | null {
  try {
    return localStorage.getItem(LAST_PATH_KEY);
  } catch {
    return null;
  }
}

/** Keeps recents pointing at moved files (a folder move moves everything under it). */
export function renameRecent(from: string, to: string): void {
  const list = read();
  const rebase = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  if (list.some((e) => rebase(e.path) !== e.path)) {
    const seen = new Set<string>();
    write(
      list
        .map((e) => ({ ...e, path: rebase(e.path) }))
        .filter((e) => {
          if (seen.has(e.path)) return false;
          seen.add(e.path);
          return true;
        }),
    );
  }
  if (lastOpenedPath() === from) {
    try {
      localStorage.setItem(LAST_PATH_KEY, to);
    } catch {
      // ignore
    }
  }
}

/** Drops a deleted file, or everything under a deleted folder. */
export function forgetRecent(path: string): void {
  const list = read();
  const next = list.filter((e) => e.path !== path && !e.path.startsWith(path + '/'));
  if (next.length !== list.length) write(next);
}

/** "Remove from recent files": this entry only. */
export function removeRecent(path: string): void {
  const list = read();
  const next = list.filter((e) => e.path !== path);
  if (next.length !== list.length) write(next);
}

export function clearRecent(): void {
  write([]);
}

/** The entries whose files are still in the vault (`has` checks the tree), newest first. */
export function presentRecent(entries: readonly RecentEntry[], tree: { byPath: { has(path: string): boolean } } | undefined): RecentEntry[] {
  return tree ? entries.filter((e) => tree.byPath.has(e.path)) : [];
}
