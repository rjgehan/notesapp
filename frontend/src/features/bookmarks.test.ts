import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { BookmarkItem, BookmarksResponse, BookmarksUpdateRequest } from '../api/types';
import {
  BookmarkWriter,
  bookmarkLabel,
  fileBookmark,
  findFileBookmarks,
  findFolderBookmarks,
  findSearchBookmarks,
  flattenItems,
  groupBookmark,
  groupsOf,
  insertAt,
  itemAt,
  moveItem,
  rekeyBookmarks,
  removeAll,
  removeAt,
  searchBookmark,
  shiftItem,
  updateAt,
} from './bookmarks';

const file = (path: string, extra: Partial<BookmarkItem> = {}): BookmarkItem => ({ type: 'file', ctime: 1, path, ...extra });
const group = (title: string, items: BookmarkItem[]): BookmarkItem => ({ type: 'group', ctime: 2, title, items });
const paths = (items: BookmarkItem[]) => flattenItems(items).map(({ item }) => item.path ?? item.title ?? item.query);

describe('bookmark items', () => {
  const sample: BookmarkItem[] = [file('A.md'), group('G', [file('B.md'), group('Inner', [file('C.md')])]), file('D.md')];

  it('flattens in display order with paths and depths', () => {
    expect(flattenItems(sample).map((p) => [p.path.join('.'), p.depth])).toEqual([
      ['0', 0],
      ['1', 0],
      ['1.0', 1],
      ['1.1', 1],
      ['1.1.0', 2],
      ['2', 0],
    ]);
    expect(itemAt(sample, [1, 1, 0])?.path).toBe('C.md');
    expect(itemAt(sample, [5])).toBeUndefined();
    expect(groupsOf(sample).map((g) => g.item.title)).toEqual(['G', 'Inner']);
  });

  it('labels a bookmark by its title, else what it points at', () => {
    expect(bookmarkLabel(file('Projects/Plan.md'))).toBe('Plan');
    expect(bookmarkLabel(file('Projects/Plan.md', { subpath: '#Goals' }))).toBe('Goals');
    expect(bookmarkLabel(file('Plan.md', { subpath: '#^abc123' }))).toBe('Plan › ^abc123');
    expect(bookmarkLabel(file('Plan.md', { title: 'My plan' }))).toBe('My plan');
    expect(bookmarkLabel(file('image.png'))).toBe('image.png');
    expect(bookmarkLabel({ type: 'folder', path: 'Projects/Beta' })).toBe('Beta');
    expect(bookmarkLabel(searchBookmark(' tag:#work '))).toBe('tag:#work');
    expect(bookmarkLabel({ type: 'group', items: [] })).toBe('Untitled group');
    expect(bookmarkLabel({ type: 'url', url: 'https://example.com' })).toBe('https://example.com');
    expect(bookmarkLabel({ type: 'graph' })).toBe('graph');
  });

  it('inserts, updates and removes at a path without touching the input', () => {
    const frozen = structuredClone(sample);
    const added = insertAt(sample, [1, 1], file('E.md'), 0);
    expect(paths(added)).toEqual(['A.md', 'G', 'B.md', 'Inner', 'E.md', 'C.md', 'D.md']);
    expect(paths(updateAt(sample, [1, 0], (i) => ({ ...i, path: 'B2.md' })))).toContain('B2.md');
    expect(paths(removeAt(sample, [1, 1]))).toEqual(['A.md', 'G', 'B.md', 'D.md']);
    expect(sample).toEqual(frozen);
  });

  it('moves an item before an index, into a group, or out of one', () => {
    expect(paths(moveItem(sample, [0], [], 3))).toEqual(['G', 'B.md', 'Inner', 'C.md', 'D.md', 'A.md']);
    expect(paths(moveItem(sample, [2], [], 0))).toEqual(['D.md', 'A.md', 'G', 'B.md', 'Inner', 'C.md']);
    // Into a later group: removing the item first shifts the group's index.
    expect(paths(moveItem(sample, [0], [1, 1], Number.MAX_SAFE_INTEGER))).toEqual(['G', 'B.md', 'Inner', 'C.md', 'A.md', 'D.md']);
    expect(paths(moveItem(sample, [1, 1, 0], [], 0))).toEqual(['C.md', 'A.md', 'G', 'B.md', 'Inner', 'D.md']);
    // A group never moves into itself.
    expect(moveItem(sample, [1], [1, 1], 0)).toEqual(sample);
  });

  it('shifts an item up and down within its list', () => {
    expect(paths(shiftItem(sample, [0], 1))).toEqual(['G', 'B.md', 'Inner', 'C.md', 'A.md', 'D.md']);
    expect(paths(shiftItem(sample, [2], -1))).toEqual(['A.md', 'D.md', 'G', 'B.md', 'Inner', 'C.md']);
    expect(shiftItem(sample, [0], -1)).toEqual(sample);
    expect(paths(shiftItem(sample, [1, 0], 1))).toEqual(['A.md', 'G', 'Inner', 'C.md', 'B.md', 'D.md']);
  });

  it('finds file, heading, folder and search bookmarks ignoring case and Unicode form', () => {
    const items = [file('Café.md'), file('Plan.md', { subpath: '#Next  Steps' }), { type: 'folder', path: 'Projects' }, searchBookmark('tag:#a')];
    expect(findFileBookmarks(items, 'café.md')).toEqual([[0]]);
    expect(findFileBookmarks(items, 'Plan.md')).toEqual([]);
    expect(findFileBookmarks(items, 'plan.md', '#next steps')).toEqual([[1]]);
    expect(findFolderBookmarks(items, 'projects')).toEqual([[2]]);
    expect(findSearchBookmarks(items, ' tag:#a ')).toEqual([[3]]);
    expect(paths(removeAll(items, [[3], [0]]))).toEqual(['Plan.md', 'Projects']);
  });

  it('creates new bookmarks in Obsidian’s shape', () => {
    expect(fileBookmark('A.md', null, 5)).toEqual({ type: 'file', ctime: 5, path: 'A.md' });
    expect(fileBookmark('A.md', '#H', 5)).toEqual({ type: 'file', ctime: 5, path: 'A.md', subpath: '#H' });
    expect(groupBookmark('G', 5)).toEqual({ type: 'group', ctime: 5, title: 'G', items: [] });
  });

  it('re-keys like the server after a move', () => {
    const items: BookmarkItem[] = [file('plan.md'), group('G', [file('Folder/Deep/x.md'), { type: 'folder', path: 'Folder' }]), file('Other.md')];
    const moved = rekeyBookmarks(items, 'Plan.md', 'Archive/Plan.md', 'file', () => false);
    expect(paths(moved!)).toEqual(['Archive/Plan.md', 'G', 'Folder/Deep/x.md', 'Folder', 'Other.md']);
    const folder = rekeyBookmarks(items, 'folder', 'Work/Folder', 'folder', () => false);
    expect(paths(folder!)).toEqual(['plan.md', 'G', 'Work/Folder/Deep/x.md', 'Work/Folder', 'Other.md']);
    expect(rekeyBookmarks(items, 'Nothing.md', 'X.md', 'file', () => false)).toBeNull();
    // A case variant that still exists keeps its bookmark.
    expect(rekeyBookmarks(items, 'Plan.md', 'P.md', 'file', (p) => p === 'plan.md')).toBeNull();
  });
});

describe('BookmarkWriter', () => {
  function setup(initial: BookmarkItem[] = []) {
    let server: BookmarksResponse = { version: 'v0', items: initial };
    let cache: BookmarksResponse | undefined = server;
    let n = 0;
    const puts: BookmarksUpdateRequest[] = [];
    const deps = {
      cached: () => cache,
      fetch: vi.fn(async () => server),
      put: vi.fn(async (req: BookmarksUpdateRequest) => {
        puts.push(req);
        if (req.baseVersion !== server.version) {
          throw new ApiError({ type: 'urn:notesapp:problem:version-conflict', title: 'Version conflict', status: 409, code: 'version-conflict' });
        }
        server = { version: `v${++n}`, items: req.items };
        return server;
      }),
      store: vi.fn((saved: BookmarksResponse) => {
        cache = saved;
      }),
      onError: vi.fn(),
    };
    const writer = new BookmarkWriter(deps);
    return {
      writer,
      deps,
      puts,
      server: () => server,
      setServer: (s: BookmarksResponse) => {
        server = s;
      },
      cache: () => cache,
    };
  }

  it('shows an edit at once and saves it with the cached version', async () => {
    const t = setup();
    const done = t.writer.edit((items) => insertAt(items, [], file('A.md')));
    expect(paths(t.writer.view(t.cache()?.items))).toEqual(['A.md']);
    await done;
    expect(t.puts).toEqual([{ items: [file('A.md')], baseVersion: 'v0' }]);
    expect(t.cache()).toEqual({ version: 'v1', items: [file('A.md')] });
    expect(paths(t.writer.view(t.cache()?.items))).toEqual(['A.md']);
  });

  it('sends one request at a time and the edits made meanwhile in the next', async () => {
    const t = setup();
    const first = t.writer.edit((items) => insertAt(items, [], file('A.md')));
    void t.writer.edit((items) => insertAt(items, [], file('B.md')));
    void t.writer.edit((items) => insertAt(items, [], file('C.md')));
    expect(paths(t.writer.view(t.cache()?.items))).toEqual(['A.md', 'B.md', 'C.md']);
    await first;
    await t.writer.idle();
    expect(t.puts.map((p) => [p.baseVersion, paths(p.items)])).toEqual([
      ['v0', ['A.md']],
      ['v1', ['A.md', 'B.md', 'C.md']],
    ]);
    expect(paths(t.writer.view(t.cache()?.items))).toEqual(['A.md', 'B.md', 'C.md']);
  });

  it('applies the edit again on top of another device’s change after a conflict', async () => {
    const t = setup([file('Mine.md')]);
    t.setServer({ version: 'other', items: [file('Mine.md'), file('Theirs.md')] });
    await t.writer.edit((items) => removeAt(items, [0]));
    expect(t.puts.map((p) => p.baseVersion)).toEqual(['v0', 'other']);
    expect(paths(t.server().items)).toEqual(['Theirs.md']);
    expect(t.cache()?.items).toEqual(t.server().items);
    expect(t.deps.onError).not.toHaveBeenCalled();
  });

  it('drops an edit the server refuses and reports it', async () => {
    const t = setup([file('A.md')]);
    t.deps.put.mockRejectedValueOnce(new ApiError({ type: 'urn:notesapp:problem:bad-request', title: 'Bad request', status: 400, code: 'bad-request' }));
    await t.writer.edit((items) => insertAt(items, [], file('../bad.md')));
    expect(t.deps.onError).toHaveBeenCalledTimes(1);
    expect(paths(t.writer.view(t.cache()?.items))).toEqual(['A.md']);
    expect(t.writer.saving).toBe(false);
  });

  it('loads the bookmarks first when nothing is cached', async () => {
    const t = setup([file('A.md')]);
    const writer = new BookmarkWriter({ ...t.deps, cached: () => undefined });
    await writer.edit((items) => insertAt(items, [], file('B.md')));
    expect(t.deps.fetch).toHaveBeenCalled();
    expect(paths(t.server().items)).toEqual(['A.md', 'B.md']);
  });

  it('tells subscribers when the view changes', async () => {
    const t = setup();
    const listener = vi.fn();
    const unsubscribe = t.writer.subscribe(listener);
    const before = t.writer.getVersion();
    await t.writer.edit((items) => insertAt(items, [], file('A.md')));
    expect(listener).toHaveBeenCalled();
    expect(t.writer.getVersion()).toBeGreaterThan(before);
    unsubscribe();
  });
});
