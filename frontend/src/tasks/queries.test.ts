import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskApi } from './api';
import { COMPLETED_PAGE, listParams, loadCompletedPage, loadView, OPEN_TASKS, scopeOf, todayParams, upcomingParams } from './queries';
import { taskStore } from './store';
import { makeList, makeTask } from './testing';

afterEach(() => taskStore.reset());

const lists = new Map([makeList()].map((l) => [l.id, l]));

describe('view scopes', () => {
  it('mirror the server rules of each loaded view', () => {
    const today = scopeOf(todayParams('2026-10-17'));
    expect(today(makeTask({ due: '2026-10-17' }), lists)).toBe(true);
    expect(today(makeTask({ due: '2026-10-18' }), lists)).toBe(false);
    const list = scopeOf(listParams('L1'));
    expect(list(makeTask({ status: 'done' }), lists)).toBe(true);
    expect(list(makeTask({ listId: 'L2' }), lists)).toBe(false);
    const open = scopeOf(OPEN_TASKS);
    expect(open(makeTask({}), lists)).toBe(true);
    expect(open(makeTask({ status: 'done' }), lists)).toBe(false);
    expect(scopeOf({ view: 'search', q: 'x' })(makeTask({}), lists)).toBe(false);
    expect(scopeOf({ view: 'list', list: 'L1' })(makeTask({ status: 'done' }), lists)).toBe(false);
  });

  it('loads a view into the store and drops tasks gone from it', async () => {
    const kept = makeTask({ id: 'K' });
    taskStore.upsert([kept, makeTask({ id: 'GONE' }), makeTask({ id: 'OTHER', listId: 'L2' })]);
    const query = vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'list', lists: [...lists.values()], tasks: [kept], total: 1, problems: [{ path: 'Tasks/Bad.tasks', taskId: null, reason: 'not valid JSON' }] });
    const meta = await loadView(listParams('L1'));
    expect(query).toHaveBeenCalledWith({ view: 'list', list: 'L1', status: 'all' });
    expect(meta.problems).toHaveLength(1);
    expect([...taskStore.tasks().keys()].sort()).toEqual(['K', 'OTHER']);
  });
});

describe('the views of phase 4b', () => {
  it('upcoming and filtered list views drop what the server no longer holds in them', () => {
    const upcoming = scopeOf(upcomingParams('2026-10-17'));
    expect(upcoming(makeTask({ due: '2026-10-20' }), lists)).toBe(true);
    expect(upcoming(makeTask({ due: '2026-11-20' }), lists)).toBe(false);
    const filtered = scopeOf({ view: 'list', tag: 'home', priority: '3' });
    expect(filtered(makeTask({ tags: ['home'], priority: 3 }), lists)).toBe(true);
    expect(filtered(makeTask({ tags: ['home'], priority: 1 }), lists)).toBe(false);
    expect(filtered(makeTask({ tags: ['home'], priority: 3, status: 'done' }), lists)).toBe(false);
    expect(scopeOf({ view: 'list', status: 'all' })(makeTask({ status: 'done' }), lists)).toBe(true);
  });

  it('a page of the completed log covers down to its last completion time only', () => {
    const page = (n: number, total: number) => ({
      view: 'completed' as const,
      lists: [...lists.values()],
      tasks: Array.from({ length: n }, (_, i) => makeTask({ id: `D${i}`, status: 'done', completedAt: `2026-10-${String(20 - i).padStart(2, '0')}T10:00:00Z` })),
      total,
      problems: [],
    });
    const truncated = scopeOf({ view: 'completed' }, page(3, 10));
    expect(truncated(makeTask({ status: 'done', completedAt: '2026-10-19T00:00:00Z' }), lists)).toBe(true);
    expect(truncated(makeTask({ status: 'done', completedAt: '2026-10-01T00:00:00Z' }), lists)).toBe(false);
    expect(truncated(makeTask({ status: 'done', completedAt: null }), lists)).toBe(false);
    const whole = scopeOf({ view: 'completed' }, page(2, 2));
    expect(whole(makeTask({ status: 'done', completedAt: '2020-01-01T00:00:00Z' }), lists)).toBe(true);
    expect(whole(makeTask({ status: 'done', completedAt: null }), lists)).toBe(true);
    expect(whole(makeTask({ status: 'open' }), lists)).toBe(false);
    const older = scopeOf({ view: 'completed', before: '2026-10-10T00:00:00Z' }, page(2, 2));
    expect(older(makeTask({ status: 'done', completedAt: '2026-10-12T00:00:00Z' }), lists)).toBe(false);
  });

  it('pages the completed log a millisecond after the last time, so tasks completed together are not skipped', async () => {
    const at = '2026-10-17T10:00:00.120Z';
    const query = vi
      .spyOn(taskApi, 'query')
      .mockResolvedValueOnce({ view: 'completed', lists: [...lists.values()], tasks: [makeTask({ id: 'P', status: 'done', completedAt: at })], total: 3, problems: [] })
      .mockResolvedValueOnce({ view: 'completed', lists: [...lists.values()], tasks: [makeTask({ id: 'C', status: 'done', completedAt: at })], total: 2, problems: [] });
    const first = await loadCompletedPage({}, undefined);
    expect(query).toHaveBeenLastCalledWith({ view: 'completed', limit: COMPLETED_PAGE });
    expect(first).toMatchObject({ next: '2026-10-17T10:00:00.121Z', floor: at, count: 1 });
    const second = await loadCompletedPage({ list: 'L1' }, first.next!);
    expect(query).toHaveBeenLastCalledWith({ view: 'completed', list: 'L1', limit: COMPLETED_PAGE, before: '2026-10-17T10:00:00.121Z' });
    // The same instant again: the log cannot move on, so it ends rather than loop.
    expect(second.next).toBeNull();
    expect([...taskStore.tasks().keys()].sort()).toEqual(['C', 'P']);
  });
});
