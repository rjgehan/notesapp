import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TextFile, TreeResponse } from '../api/types';
import { evictions, IdbNoteCache, MAX_NOTE_CHARS, planMaintenance, type CacheIndexEntry } from './noteCache';

const file = (path: string, content = 'text', version = 'v-' + content): TextFile => ({
  path,
  kind: 'note',
  content,
  version,
  size: content.length,
  mtime: '2026-10-21T10:00:00.000Z',
  lossy: false,
});

describe('IdbNoteCache', () => {
  let cache: IdbNoteCache;

  beforeEach(() => {
    cache = new IdbNoteCache(new IDBFactory());
  });

  it('keeps an opened note and finds it again', async () => {
    await cache.put(file('a.md', 'one'), true, 1000);
    const hit = await cache.get('a.md');
    expect(hit).toMatchObject({ path: 'a.md', at: 1000, storedAt: 1000 });
    expect(hit?.file.content).toBe('one');
    expect(await cache.get('b.md')).toBeNull();
  });

  it('a refresh updates an existing copy without changing when it was opened, and never adds one', async () => {
    await cache.put(file('a.md', 'one'), true, 1000);
    await cache.put(file('a.md', 'two'), false, 5000);
    expect(await cache.get('a.md')).toMatchObject({ at: 1000, storedAt: 5000, file: { content: 'two' } });
    await cache.put(file('b.md'), false, 5000);
    expect(await cache.get('b.md')).toBeNull();
  });

  it('never keeps lossy or huge files', async () => {
    await cache.put(file('a.md', 'one'), true);
    await cache.put({ ...file('a.md', 'x'), lossy: true }, true);
    expect(await cache.get('a.md')).toBeNull();
    await cache.put(file('big.md', 'x'.repeat(MAX_NOTE_CHARS + 1)), true);
    expect(await cache.get('big.md')).toBeNull();
  });

  it('re-keys a copy after a move', async () => {
    await cache.put(file('a.md', 'one'), true, 1000);
    await cache.rekey('a.md', 'Folder/b.md');
    expect(await cache.get('a.md')).toBeNull();
    expect(await cache.get('Folder/b.md')).toMatchObject({ path: 'Folder/b.md', file: { path: 'Folder/b.md', content: 'one' } });
  });

  it('drops the least recently opened notes beyond the limit', async () => {
    for (let i = 0; i < 102; i++) await cache.put(file(`n${i}.md`), true, 1000 + i);
    const index = await cache.index();
    expect(index).toHaveLength(100);
    expect(index.map((e) => e.path)).not.toContain('n0.md');
    expect(index.map((e) => e.path)).not.toContain('n1.md');
    expect(index.map((e) => e.path)).toContain('n101.md');
  });

  it('keeps the tree snapshot and clears everything on request', async () => {
    const tree: TreeResponse = { eventId: 'b.1', folders: [], files: [] };
    await cache.saveTree(tree, 42);
    expect(await cache.loadTree()).toEqual({ key: 'tree', tree, at: 42 });
    await cache.put(file('a.md'), true);
    await cache.clear();
    expect(await cache.loadTree()).toBeNull();
    expect(await cache.index()).toEqual([]);
  });
});

describe('offline copy upkeep', () => {
  const entry = (path: string, version: string, at = 0, chars = 10): CacheIndexEntry => ({ path, version, at, chars });

  it('evicts by count and by total size, oldest first', () => {
    const entries = [entry('a', 'v', 1), entry('b', 'v', 3), entry('c', 'v', 2)];
    expect(evictions(entries, 2)).toEqual(['a']);
    expect(evictions(entries, 10, 25)).toEqual(['a']);
    expect(evictions(entries, 10, 15)).toEqual(['c', 'a']);
  });

  it('re-reads outdated copies, follows moves and drops deleted notes', () => {
    const files = new Map([
      ['same.md', { version: 'v1' }],
      ['changed.md', { version: 'v3' }],
      ['Moved/to.md', { version: 'v5' }],
      ['Moved/edited.md', { version: 'v9' }],
    ]);
    const moves: Record<string, string> = { 'from.md': 'Moved/to.md', 'old.md': 'Moved/edited.md', 'gone-too.md': 'nowhere.md' };
    const plan = planMaintenance(
      [entry('same.md', 'v1'), entry('changed.md', 'v2'), entry('from.md', 'v5'), entry('old.md', 'v8'), entry('deleted.md', 'v1'), entry('gone-too.md', 'v1')],
      files,
      (p) => moves[p] ?? null,
    );
    expect(plan.refresh).toEqual(['changed.md', 'Moved/edited.md']);
    expect(plan.rekey).toEqual([
      ['from.md', 'Moved/to.md'],
      ['old.md', 'Moved/edited.md'],
    ]);
    expect(plan.remove).toEqual(['deleted.md', 'gone-too.md']);
  });

  it('never re-keys onto a copy that already exists', () => {
    const plan = planMaintenance([entry('a.md', 'v1'), entry('b.md', 'v1')], new Map([['b.md', { version: 'v1' }]]), () => 'b.md');
    expect(plan.rekey).toEqual([]);
    expect(plan.remove).toEqual(['a.md']);
  });
});
