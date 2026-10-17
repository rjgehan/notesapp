import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertFiles } from '../sync/treePatch';
import { api } from './endpoints';
import { refetchTree } from './hooks';
import { queryClient } from './queryClient';
import { queryKeys } from './queryKeys';
import type { FileEntry, TreeResponse } from './types';

const file = (path: string): FileEntry => ({ path, name: path, basename: path.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v1', aliases: [] });
const snapshot = (eventId: string, paths: string[]): TreeResponse => ({ eventId, folders: [], files: paths.map(file) });

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('refetchTree (FE-12)', () => {
  it('fetches again when an own mutation patched the tree while the snapshot was in flight', async () => {
    queryClient.setQueryData(queryKeys.tree(), snapshot('b.1', ['a.md']));
    const getTree = vi.spyOn(api, 'getTree');
    getTree.mockImplementationOnce(async () => {
      // A note created by this tab is answered before the (older) snapshot.
      upsertFiles(queryClient, [file('new.md')]);
      return snapshot('b.2', ['a.md']);
    });
    getTree.mockImplementationOnce(async () => snapshot('b.3', ['a.md', 'new.md']));
    const tree = await refetchTree();
    expect(tree.eventId).toBe('b.3');
    expect(queryClient.getQueryData<TreeResponse>(queryKeys.tree())!.files.map((f) => f.path)).toEqual(['a.md', 'new.md']);
  });

  it('fetches once when nothing patched the tree meanwhile', async () => {
    const getTree = vi.spyOn(api, 'getTree').mockImplementation(async () => snapshot('b.1', ['a.md']));
    await refetchTree();
    expect(getTree).toHaveBeenCalledTimes(1);
  });
});
