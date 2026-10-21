import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, TreeResponse } from '../api/types';
import { TASK_EVENT_NAMES } from '../api/types';
import { TaskStore } from './store';
import { acknowledgeFiles, applyTaskEvent, installTaskSync, REFETCH_DEBOUNCE_MS, resetTaskSync } from './sync';
import { makeList, makeTask } from './testing';

function entry(path: string, version: string | null): FileEntry {
  return { path, name: path.split('/').pop()!, basename: '', extension: 'tasks', kind: 'text', size: 1, mtime: '2026-10-17T10:00:00.000Z', version, aliases: [] };
}

function tree(files: FileEntry[]): TreeResponse {
  return { eventId: 'b.1', folders: [{ path: 'Tasks', name: 'Tasks' }], files };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTaskSync();
});

afterEach(() => {
  resetTaskSync();
  vi.useRealTimers();
});

describe('task events (API.md §20.8)', () => {
  it('applies created, changed and deleted tasks and changed or deleted lists', () => {
    const store = new TaskStore();
    const t = makeTask({ id: 'A', title: 'one' });
    applyTaskEvent(store, 'task.created', { task: t, origin: 'other' });
    applyTaskEvent(store, 'task.changed', { task: { ...t, title: 'two' }, origin: 'other' });
    expect(store.task('A')?.title).toBe('two');
    applyTaskEvent(store, 'task.deleted', { id: 'A', listId: 'L1', origin: 'other' });
    expect(store.task('A')).toBeUndefined();
    applyTaskEvent(store, 'list.changed', { listId: 'L1', list: makeList({ name: 'Renamed' }), origin: 'other' });
    expect(store.list('L1')?.name).toBe('Renamed');
    store.upsert([makeTask({ id: 'B' })]);
    applyTaskEvent(store, 'list.changed', { listId: 'L1', list: null, origin: 'other' });
    expect(store.list('L1')).toBeUndefined();
    expect(store.task('B')).toBeUndefined();
  });

  it('refetches after the archive rollover, which sends no task events', () => {
    const refetch = vi.fn();
    const qc = new QueryClient();
    installTaskSync(new TaskStore(), qc, () => {}, refetch);
    applyTaskEvent(new TaskStore(), 'list.changed', { listId: 'L1', list: makeList(), origin: null });
    vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('registers a handler for every task event name', () => {
    const names: string[] = [];
    installTaskSync(new TaskStore(), new QueryClient(), (name) => names.push(name), vi.fn());
    expect(names).toEqual([...TASK_EVENT_NAMES]);
  });
});

describe('the tree watcher', () => {
  it('refetches the views once, debounced, when a .tasks file changes without task events', async () => {
    const refetch = vi.fn();
    const qc = new QueryClient();
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v1'), entry('Notes.md', 'n1')]));
    const stop = installTaskSync(new TaskStore(), qc, () => {}, refetch);
    // A note save is not a task change.
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v1'), entry('Notes.md', 'n2')]));
    await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS * 2);
    expect(refetch).not.toHaveBeenCalled();
    // A hand edit, then a new list file, close together: one refetch.
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v2'), entry('Notes.md', 'n2')]));
    await vi.advanceTimersByTimeAsync(10);
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v2'), entry('Tasks/Work.tasks', 'w1'), entry('Notes.md', 'n2')]));
    await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    // A deleted list file.
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v2'), entry('Notes.md', 'n2')]));
    await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS);
    expect(refetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores this tab’s own task writes, which it acknowledges first', async () => {
    const refetch = vi.fn();
    const qc = new QueryClient();
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v1')]));
    const stop = installTaskSync(new TaskStore(), qc, () => {}, refetch);
    acknowledgeFiles([entry('Tasks/Home.tasks', 'v2'), entry('Tasks/Inbox.tasks', 'i1')]);
    qc.setQueryData(['tree'], tree([entry('Tasks/Home.tasks', 'v2'), entry('Tasks/Inbox.tasks', 'i1')]));
    await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS * 2);
    expect(refetch).not.toHaveBeenCalled();
    stop();
  });
});
