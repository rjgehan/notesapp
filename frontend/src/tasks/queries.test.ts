import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskApi } from './api';
import { listParams, loadView, OPEN_TASKS, scopeOf, todayParams } from './queries';
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
