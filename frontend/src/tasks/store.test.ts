import { describe, expect, it, vi } from 'vitest';
import type { TasksResponse } from '../api/types';
import { inList } from './model';
import { TaskStore } from './store';
import { makeList, makeTask } from './testing';

const list = makeList();

function response(tasks = [] as ReturnType<typeof makeTask>[], lists = [list]): TasksResponse {
  return { view: 'list', lists, tasks, total: tasks.length, problems: [] };
}

const inHome = (t: ReturnType<typeof makeTask>) => inList(t, 'L1');

describe('TaskStore (DESIGN §6.22)', () => {
  it('merges a response, dropping tasks the view no longer has', () => {
    const store = new TaskStore();
    const a = makeTask({ id: 'A' });
    const b = makeTask({ id: 'B' });
    const elsewhere = makeTask({ id: 'W', listId: 'L2' });
    store.mergeResponse(response([a, b, elsewhere]), () => true, store.generation());
    // B was removed by a hand edit: the next response of the same view lacks it.
    store.mergeResponse(response([a]), inHome, store.generation());
    expect([...store.tasks().keys()].sort()).toEqual(['A', 'W']);
    expect(store.lists().map((l) => l.id)).toEqual(['L1']);
  });

  it('never lets a response that started before an event undo it', () => {
    const store = new TaskStore();
    const a = makeTask({ id: 'A', title: 'old' });
    store.mergeResponse(response([a]), inHome, store.generation());
    const since = store.generation();
    // An event arrives while the GET is in flight…
    store.upsert([{ ...a, title: 'new' }]);
    store.upsert([makeTask({ id: 'C', title: 'created meanwhile' })]);
    // …and the response, computed before it, says the old state.
    store.mergeResponse(response([a]), inHome, since);
    expect(store.task('A')?.title).toBe('new');
    expect(store.task('C')).toBeDefined();
    // A removal during the request is not undone either.
    const since2 = store.generation();
    store.remove(['A']);
    store.mergeResponse(response([a]), inHome, since2);
    expect(store.task('A')).toBeUndefined();
  });

  it('keeps lists changed by events while a lists request was in flight', () => {
    const store = new TaskStore();
    store.setLists([list], [], store.generation());
    const since = store.generation();
    store.upsertLists([{ ...list, name: 'Renamed' }]);
    store.upsertLists([makeList({ id: 'L9', name: 'New', order: 'a5' })]);
    store.setLists([list], [], since);
    expect(store.lists().map((l) => l.name)).toEqual(['Renamed', 'New']);
  });

  it('layers optimistic changes and rolls them back by dropping the layer', () => {
    const store = new TaskStore();
    const a = makeTask({ id: 'A', title: 'Pay rent' });
    const b = makeTask({ id: 'B' });
    store.upsert([a, b]);
    const pending = makeTask({ id: 'pending-1', title: 'New' });
    const overlay = store.addOverlay(new Map([['A', { status: 'done' as const }], ['B', null]]), [pending]);
    expect(store.task('A')?.status).toBe('done');
    expect(store.task('B')).toBeUndefined();
    expect(store.task('pending-1')).toBeDefined();
    expect(store.knownTask('A')?.status).toBe('open');
    expect(store.hasPending('A')).toBe(true);
    // An event for the same task meanwhile changes another field: both show.
    store.upsert([{ ...a, title: 'Pay the rent' }]);
    expect(store.task('A')).toMatchObject({ status: 'done', title: 'Pay the rent' });
    store.dropOverlay(overlay);
    expect(store.task('A')).toMatchObject({ status: 'open', title: 'Pay the rent' });
    expect(store.task('B')).toBeDefined();
    expect(store.task('pending-1')).toBeUndefined();
  });

  it('applies stacked layers in order, so dropping the first keeps the second', () => {
    const store = new TaskStore();
    store.upsert([makeTask({ id: 'A', title: 'one', priority: 0 })]);
    const first = store.addOverlay(new Map([['A', { title: 'two' }]]));
    store.addOverlay(new Map([['A', { priority: 3 as const }]]));
    store.dropOverlay(first);
    expect(store.task('A')).toMatchObject({ title: 'one', priority: 3 });
  });

  it('removes a deleted list with its tasks', () => {
    const store = new TaskStore();
    store.setLists([list, makeList({ id: 'L2', order: 'a1' })], [], store.generation());
    store.upsert([makeTask({ id: 'A' }), makeTask({ id: 'B', listId: 'L2' })]);
    store.removeList('L1');
    expect([...store.tasks().keys()]).toEqual(['B']);
    expect(store.lists().map((l) => l.id)).toEqual(['L2']);
  });

  it('merges single tasks unless something newer arrived', () => {
    const store = new TaskStore();
    const since = store.generation();
    store.upsert([makeTask({ id: 'A', title: 'event' })]);
    store.mergeTasks([makeTask({ id: 'A', title: 'fetched' }), makeTask({ id: 'B' })], since);
    expect(store.task('A')?.title).toBe('event');
    expect(store.task('B')).toBeDefined();
  });

  it('notifies subscribers and memoizes the merged view per version', () => {
    const store = new TaskStore();
    const fn = vi.fn();
    const unsubscribe = store.subscribe(fn);
    store.upsert([makeTask({ id: 'A' })]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.tasks()).toBe(store.tasks());
    unsubscribe();
    store.upsert([makeTask({ id: 'B' })]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
