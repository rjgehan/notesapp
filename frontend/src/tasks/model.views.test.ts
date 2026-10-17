import { describe, expect, it } from 'vitest';
import { compareCompleted, filterFromParams, inListView, inUpcoming, matchesFilter, prioritiesOf, statusesOf } from './model';
import { makeList, makeTask } from './testing';

const lists = new Map([
  ['L1', makeList()],
  ['L2', makeList({ id: 'L2', name: 'Old', archived: true, path: 'Tasks/Old.tasks' })],
]);

describe('Upcoming (view=upcoming, API.md §20.2)', () => {
  it('holds the open tasks of active lists due (else starting) from today to today + days - 1', () => {
    const today = '2026-10-17';
    expect(inUpcoming(makeTask({ due: '2026-10-17' }), today, 14, lists)).toBe(true);
    expect(inUpcoming(makeTask({ due: '2026-10-30T09:00' }), today, 14, lists)).toBe(true);
    expect(inUpcoming(makeTask({ due: '2026-10-31' }), today, 14, lists)).toBe(false);
    expect(inUpcoming(makeTask({ due: '2026-10-16' }), today, 14, lists)).toBe(false);
    expect(inUpcoming(makeTask({ start: '2026-10-20' }), today, 14, lists)).toBe(true);
    // The due date wins over the start date.
    expect(inUpcoming(makeTask({ start: '2026-10-20', due: '2026-11-20' }), today, 14, lists)).toBe(false);
    expect(inUpcoming(makeTask({ due: '2026-10-18', status: 'done' }), today, 14, lists)).toBe(false);
    expect(inUpcoming(makeTask({ due: '2026-10-18', listId: 'L2' }), today, 14, lists)).toBe(false);
    expect(inUpcoming(makeTask({}), today, 14, lists)).toBe(false);
  });
});

describe('filters (tag, priority, list, status)', () => {
  it('match tags from the field and the title, nested ones too, ignoring case and #', () => {
    const t = makeTask({ title: 'Mow #Garden/Lawn', tags: ['home'], priority: 2 });
    expect(matchesFilter(t, { tag: 'home' })).toBe(true);
    expect(matchesFilter(t, { tag: '#garden' })).toBe(true);
    expect(matchesFilter(t, { tag: 'garden/lawn' })).toBe(true);
    expect(matchesFilter(t, { tag: 'gard' })).toBe(false);
    expect(matchesFilter(t, { priority: '2,3' })).toBe(true);
    expect(matchesFilter(t, { priority: '0' })).toBe(false);
    expect(matchesFilter(t, { list: 'L1' })).toBe(true);
    expect(matchesFilter(t, { list: 'L2' })).toBe(false);
  });

  it('read priorities and statuses as the server does', () => {
    expect([...prioritiesOf('3, 1,9,x')!]).toEqual([3, 1]);
    expect(prioritiesOf('')).toBeNull();
    expect([...statusesOf(undefined, 'list')]).toEqual(['open']);
    expect([...statusesOf(undefined, 'completed')]).toEqual(['done', 'cancelled']);
    expect([...statusesOf('all', 'list')].sort()).toEqual(['cancelled', 'done', 'open']);
  });

  it('take a filter from the address, cleaned', () => {
    expect(filterFromParams(new URLSearchParams('tag=%23home&priority=3,2,7&list=L1&status=all&q=x'))).toEqual({ list: 'L1', tag: 'home', priority: '2,3', status: 'all' });
    expect(filterFromParams(new URLSearchParams('status=done&tag=+'))).toEqual({});
  });

  it('list one list (archived or not) or every active one, never archive files', () => {
    expect(inListView(makeTask({ listId: 'L2' }), lists)).toBe(false);
    expect(inListView(makeTask({ listId: 'L2' }), lists, 'L2')).toBe(true);
    expect(inListView(makeTask({ archived: true }), lists)).toBe(false);
  });
});

describe('the completed order', () => {
  it('is newest first, then by id descending, with tasks without a time last', () => {
    const tasks = [
      makeTask({ id: 'A', completedAt: '2026-10-01T10:00:00Z' }),
      makeTask({ id: 'B', completedAt: null }),
      makeTask({ id: 'C', completedAt: '2026-10-05T10:00:00.5Z' }),
      makeTask({ id: 'D', completedAt: '2026-10-05T10:00:00.500Z' }),
    ];
    expect(tasks.sort(compareCompleted).map((t) => t.id)).toEqual(['D', 'C', 'A', 'B']);
  });
});
