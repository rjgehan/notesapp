// Bookmarks (ROADMAP item 12, DESIGN §6.23): pure helpers over Obsidian-format bookmark items, and
// the writer that saves them with the version protocol (API.md §21). Items are addressed by their
// index path through nested groups (`[2, 0]` = the first item of the third item, a group).
import { isProblem } from '../api/client';
import type { BookmarkItem, BookmarksResponse, BookmarksUpdateRequest } from '../api/types';
import { displayName, lastSegment } from './paths';

export type ItemPath = readonly number[];

/** A bookmark with where it is: its index path and nesting depth (0 = top level). */
export interface PlacedItem {
  item: BookmarkItem;
  path: ItemPath;
  depth: number;
}

export function isGroup(item: BookmarkItem): boolean {
  return item.type === 'group';
}

/** The heading (or `^blockid`) a file bookmark's subpath points at, without the leading '#'. */
export function subpathTarget(item: BookmarkItem): string | null {
  const s = typeof item.subpath === 'string' ? item.subpath : '';
  return s.startsWith('#') && s.length > 1 ? s.slice(1) : null;
}

/** The label shown for a bookmark: its title, else what it points at. */
export function bookmarkLabel(item: BookmarkItem): string {
  if (typeof item.title === 'string' && item.title.trim() !== '') return item.title;
  switch (item.type) {
    case 'file': {
      const path = item.path ?? '';
      const sub = subpathTarget(item);
      if (sub) {
        const heading = sub.split('#').pop() ?? sub;
        return heading.startsWith('^') ? `${displayName(path)} › ${heading}` : heading;
      }
      return displayName(path);
    }
    case 'folder':
      return lastSegment(item.path ?? '') || 'Vault';
    case 'search':
      return item.query ?? '';
    case 'group':
      return 'Untitled group';
    case 'url':
      return typeof item.url === 'string' ? item.url : 'Link';
    default:
      return item.type;
  }
}

/** Every bookmark in display order, groups before their contents. */
export function flattenItems(items: readonly BookmarkItem[], base: ItemPath = [], depth = 0): PlacedItem[] {
  const out: PlacedItem[] = [];
  items.forEach((item, i) => {
    const path = [...base, i];
    out.push({ item, path, depth });
    if (isGroup(item) && Array.isArray(item.items)) out.push(...flattenItems(item.items, path, depth + 1));
  });
  return out;
}

export function itemAt(items: readonly BookmarkItem[], path: ItemPath): BookmarkItem | undefined {
  let list: readonly BookmarkItem[] | undefined = items;
  let item: BookmarkItem | undefined;
  for (const i of path) {
    item = list?.[i];
    if (!item) return undefined;
    list = Array.isArray(item.items) ? item.items : undefined;
  }
  return item;
}

/** A copy of `items` with the list at `parent` (a group's path, or [] for the top level) replaced by `edit(list)`. */
function editList(items: readonly BookmarkItem[], parent: ItemPath, edit: (list: BookmarkItem[]) => BookmarkItem[]): BookmarkItem[] {
  if (parent.length === 0) return edit([...items]);
  const [head, ...rest] = parent;
  const group = items[head];
  if (!group || !isGroup(group)) return [...items];
  const out = [...items];
  out[head] = { ...group, items: editList(Array.isArray(group.items) ? group.items : [], rest, edit) };
  return out;
}

export function removeAt(items: readonly BookmarkItem[], path: ItemPath): BookmarkItem[] {
  if (path.length === 0) return [...items];
  return editList(items, path.slice(0, -1), (list) => {
    list.splice(path[path.length - 1], 1);
    return list;
  });
}

export function updateAt(items: readonly BookmarkItem[], path: ItemPath, update: (item: BookmarkItem) => BookmarkItem): BookmarkItem[] {
  if (path.length === 0) return [...items];
  return editList(items, path.slice(0, -1), (list) => {
    const i = path[path.length - 1];
    if (list[i]) list[i] = update(list[i]);
    return list;
  });
}

/** Inserts into the list at `parent` ([] = top level) at `index` (default: the end). */
export function insertAt(items: readonly BookmarkItem[], parent: ItemPath, item: BookmarkItem, index?: number): BookmarkItem[] {
  return editList(items, parent, (list) => {
    list.splice(index ?? list.length, 0, item);
    return list;
  });
}

function isPrefix(prefix: ItemPath, path: ItemPath): boolean {
  return prefix.length <= path.length && prefix.every((v, i) => path[i] === v);
}

/**
 * Moves the item at `from` into the list at `parent` at `index` (an index in that list as it is
 * before the move). Moving a group into itself or its own contents changes nothing.
 */
export function moveItem(items: readonly BookmarkItem[], from: ItemPath, parent: ItemPath, index: number): BookmarkItem[] {
  const item = itemAt(items, from);
  if (!item || isPrefix(from, parent)) return [...items];
  const fromParent = from.slice(0, -1);
  const fromIndex = from[from.length - 1];
  // Removing the item shifts later siblings (and the target list, when it is one of them).
  const target = [...parent];
  let at = index;
  if (fromParent.length < target.length && isPrefix(fromParent, target) && target[fromParent.length] > fromIndex) {
    target[fromParent.length]--;
  }
  if (fromParent.length === target.length && isPrefix(fromParent, target) && at > fromIndex) at--;
  return insertAt(removeAt(items, from), target, item, at);
}

/** Moves an item one place up (-1) or down (+1) within its list. */
export function shiftItem(items: readonly BookmarkItem[], path: ItemPath, delta: -1 | 1): BookmarkItem[] {
  const parent = path.slice(0, -1);
  const i = path[path.length - 1];
  const list = parent.length === 0 ? items : itemAt(items, parent)?.items;
  const j = i + delta;
  if (!Array.isArray(list) || j < 0 || j >= list.length) return [...items];
  return moveItem(items, path, parent, delta > 0 ? j + 1 : j);
}

/** Same vault path, ignoring case and Unicode normalization, as link resolution does. */
export function samePath(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

function sameSubpath(a: unknown, b: string | null | undefined): boolean {
  const x = typeof a === 'string' && a !== '' ? a : null;
  const y = b ? b : null;
  if (x === null || y === null) return x === y;
  return x.replace(/\s+/g, ' ').trim().toLowerCase() === y.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The paths of the file bookmarks of `path` (with exactly this `subpath`, '#Heading', or none). */
export function findFileBookmarks(items: readonly BookmarkItem[], path: string, subpath: string | null = null): ItemPath[] {
  return flattenItems(items)
    .filter(({ item }) => item.type === 'file' && typeof item.path === 'string' && samePath(item.path, path) && sameSubpath(item.subpath, subpath))
    .map((p) => p.path);
}

export function findFolderBookmarks(items: readonly BookmarkItem[], path: string): ItemPath[] {
  return flattenItems(items)
    .filter(({ item }) => item.type === 'folder' && typeof item.path === 'string' && samePath(item.path, path))
    .map((p) => p.path);
}

export function findSearchBookmarks(items: readonly BookmarkItem[], query: string): ItemPath[] {
  const q = query.trim();
  return flattenItems(items)
    .filter(({ item }) => item.type === 'search' && typeof item.query === 'string' && item.query.trim() === q)
    .map((p) => p.path);
}

/** Removes the items at `paths`, deepest and last first so the other paths stay valid. */
export function removeAll(items: readonly BookmarkItem[], paths: readonly ItemPath[]): BookmarkItem[] {
  const ordered = [...paths].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return b[i] - a[i];
    return b.length - a.length;
  });
  return ordered.reduce<BookmarkItem[]>((acc, p) => removeAt(acc, p), [...items]);
}

export function fileBookmark(path: string, subpath: string | null = null, now = Date.now()): BookmarkItem {
  return subpath ? { type: 'file', ctime: now, path, subpath } : { type: 'file', ctime: now, path };
}

export function folderBookmark(path: string, now = Date.now()): BookmarkItem {
  return { type: 'folder', ctime: now, path };
}

export function searchBookmark(query: string, now = Date.now()): BookmarkItem {
  return { type: 'search', ctime: now, query: query.trim() };
}

export function groupBookmark(title: string, now = Date.now()): BookmarkItem {
  return { type: 'group', ctime: now, title, items: [] };
}

/** Every group with its path and depth, for "Move to group". */
export function groupsOf(items: readonly BookmarkItem[]): PlacedItem[] {
  return flattenItems(items).filter(({ item }) => isGroup(item));
}

/**
 * The server's re-keying after a move (DESIGN §5.21), for the mock: bookmarks of the moved file,
 * or of the folder and anything under it, follow it; matching ignores case unless an entry with
 * the bookmark's exact path still exists.
 */
export function rekeyBookmarks(items: readonly BookmarkItem[], from: string, to: string, type: 'file' | 'folder', exists: (path: string) => boolean): BookmarkItem[] | null {
  let changed = false;
  const lowerFrom = from.toLowerCase();
  const visit = (list: readonly BookmarkItem[]): BookmarkItem[] =>
    list.map((item) => {
      if (isGroup(item) && Array.isArray(item.items)) {
        const nested = visit(item.items);
        return nested.some((n, i) => n !== item.items![i]) ? { ...item, items: nested } : item;
      }
      if ((item.type !== 'file' && item.type !== 'folder') || typeof item.path !== 'string') return item;
      const path = item.path;
      const lower = path.toLowerCase();
      let next: string | null = null;
      if (lower === lowerFrom) {
        const sameKind = (type === 'file') === (item.type === 'file');
        if (sameKind && (path === from || !exists(path))) next = to;
      } else if (type === 'folder' && lower.startsWith(lowerFrom + '/')) {
        next = to + '/' + path.split('/').slice(from.split('/').length).join('/');
      }
      if (next === null || next === path) return item;
      changed = true;
      return { ...item, path: next };
    });
  const out = visit(items);
  return changed ? out : null;
}

// ---------- the writer ----------

export type BookmarkEdit = (items: BookmarkItem[]) => BookmarkItem[];

export interface BookmarkWriterDeps {
  /** The cached server state (the query data), if loaded. */
  cached(): BookmarksResponse | undefined;
  /** Reads the server's bookmarks now. */
  fetch(): Promise<BookmarksResponse>;
  put(req: BookmarksUpdateRequest): Promise<BookmarksResponse>;
  /** Caches the server's answer. */
  store(saved: BookmarksResponse): void;
  onError(error: unknown): void;
}

/** Conflicts with other devices are retried on top of their bookmarks this many times. */
const MAX_ATTEMPTS = 4;

/**
 * Saves bookmark edits with the version protocol. An edit shows at once (`view` lays the edits not
 * yet saved over the server's bookmarks), one PUT is in flight at a time, and the edits made
 * meanwhile go in the next one. An edit is a function of the current list, so after a 409 (another
 * device saved, or the server re-keyed after a move) it is applied again to the fresh list: two
 * devices bookmarking different notes never lose either.
 */
export class BookmarkWriter {
  private readonly deps: BookmarkWriterDeps;
  private pending: BookmarkEdit[] = [];
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(deps: BookmarkWriterDeps) {
    this.deps = deps;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** The bookmarks to show: the server's, with the edits not saved yet applied. */
  view(server: readonly BookmarkItem[] | undefined): BookmarkItem[] {
    let items = [...(server ?? [])];
    for (const edit of this.pending) items = edit(items);
    return items;
  }

  get saving(): boolean {
    return this.running !== null;
  }

  /** Applies an edit; resolves when it is saved (or given up on, after `onError`). */
  edit(edit: BookmarkEdit): Promise<void> {
    this.pending.push(edit);
    this.changed();
    this.running ??= this.drain().finally(() => {
      this.running = null;
      this.changed();
    });
    return this.running;
  }

  /** Resolves when nothing is waiting to be saved. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = [...this.pending];
      try {
        const saved = await this.save(batch);
        // Dropped before the new server state is cached, so the view never applies them twice.
        this.pending = this.pending.slice(batch.length);
        this.deps.store(saved);
      } catch (e) {
        this.pending = this.pending.slice(batch.length);
        this.deps.onError(e);
      }
      this.changed();
    }
  }

  private async save(batch: BookmarkEdit[]): Promise<BookmarksResponse> {
    let base = this.deps.cached() ?? (await this.deps.fetch());
    for (let attempt = 1; ; attempt++) {
      const items = batch.reduce<BookmarkItem[]>((acc, edit) => edit(acc), [...base.items]);
      try {
        return await this.deps.put({ items, baseVersion: base.version });
      } catch (e) {
        if (!isProblem(e, 'version-conflict') || attempt >= MAX_ATTEMPTS) throw e;
      }
      base = await this.deps.fetch();
      this.deps.store(base);
    }
  }
}
