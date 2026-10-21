import { describe, expect, it } from 'vitest';
import { buildLinkIndex } from '../features/links';
import {
  buildRows,
  childrenByParent,
  depthOf,
  descendants,
  inList,
  inOpenLists,
  inToday,
  isOverdue,
  linksTo,
  scheduleComparator,
  subtreeHeight,
  taskTags,
  titleTags,
  type TaskRow,
} from './model';
import { makeList, makeSection, makeTask } from './testing';

const TODAY = '2026-10-17';
const home = makeList();
const work = makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks' });
const archived = makeList({ id: 'L3', name: 'Old', order: 'a2', archived: true, path: 'Tasks/Old.tasks' });
const lists = new Map([home, work, archived].map((l) => [l.id, l]));

describe('view rules (API.md §20.2)', () => {
  it('today: open tasks of active lists due or starting today or earlier', () => {
    expect(inToday(makeTask({ due: '2026-10-17' }), TODAY, lists)).toBe(true);
    expect(inToday(makeTask({ due: '2026-10-17T23:30' }), TODAY, lists)).toBe(true);
    expect(inToday(makeTask({ due: '2026-09-01' }), TODAY, lists)).toBe(true);
    expect(inToday(makeTask({ start: '2026-10-10', due: '2026-12-01' }), TODAY, lists)).toBe(true);
    expect(inToday(makeTask({ due: '2026-10-18' }), TODAY, lists)).toBe(false);
    expect(inToday(makeTask({}), TODAY, lists)).toBe(false);
    expect(inToday(makeTask({ due: TODAY, status: 'done' }), TODAY, lists)).toBe(false);
    expect(inToday(makeTask({ due: TODAY, listId: 'L3' }), TODAY, lists)).toBe(false);
    expect(inToday(makeTask({ due: TODAY, listId: 'nope' }), TODAY, lists)).toBe(false);
    expect(inToday(makeTask({ due: TODAY, archived: true }), TODAY, lists)).toBe(false);
  });

  it('list: every task of the list file; open lists: open tasks of active lists', () => {
    expect(inList(makeTask({ status: 'done' }), 'L1')).toBe(true);
    expect(inList(makeTask({ archived: true }), 'L1')).toBe(false);
    expect(inList(makeTask({ listId: 'L2' }), 'L1')).toBe(false);
    expect(inOpenLists(makeTask({}), lists)).toBe(true);
    expect(inOpenLists(makeTask({ status: 'cancelled' }), lists)).toBe(false);
    expect(inOpenLists(makeTask({ listId: 'L3' }), lists)).toBe(false);
  });

  it('orders like the server: date (all day first), priority, list, manual order', () => {
    const a = makeTask({ title: 'timed', due: '2026-10-17T09:00' });
    const b = makeTask({ title: 'all day', due: '2026-10-17' });
    const c = makeTask({ title: 'earlier', due: '2026-10-16T18:00' });
    const d = makeTask({ title: 'high', due: '2026-10-17', priority: 3 });
    const e = makeTask({ title: 'work list', due: '2026-10-17', listId: 'L2' });
    const f = makeTask({ title: 'start only', start: '2026-10-15' });
    const g = makeTask({ title: 'no date' });
    const sorted = [a, b, c, d, e, f, g].sort(scheduleComparator([home, work])).map((t) => t.title);
    expect(sorted).toEqual(['start only', 'earlier', 'high', 'all day', 'work list', 'timed', 'no date']);
  });

  it('overdue is a scheduled day before today', () => {
    expect(isOverdue(makeTask({ due: '2026-10-16T23:59' }), TODAY)).toBe(true);
    expect(isOverdue(makeTask({ due: TODAY }), TODAY)).toBe(false);
    expect(isOverdue(makeTask({ start: '2026-10-01' }), TODAY)).toBe(true);
  });
});

describe('tags and links', () => {
  it('reads title tags outside links, distinct ignoring case', () => {
    expect(titleTags('Fix #fence in [[Garden #plan]] #home/garden')).toEqual(['fence', 'home/garden']);
    expect(taskTags(makeTask({ tags: ['Home', 'bills'], title: 'Pay #home #rent' }))).toEqual(['Home', 'bills', 'rent']);
  });

  it('finds tasks linking to a note through links, title links and notes links', () => {
    const index = buildLinkIndex(['Apartment.md', 'Projects/Plan.md', 'Other.md']);
    expect(linksTo(makeTask({ links: ['Apartment.md'] }), 'Apartment.md', 'Tasks/Home.tasks', index)).toBe(true);
    expect(linksTo(makeTask({ title: 'Pay rent [[Apartment]]' }), 'Apartment.md', 'Tasks/Home.tasks', index)).toBe(true);
    expect(linksTo(makeTask({ title: 'See [[Plan#Goals|the plan]]' }), 'Projects/Plan.md', 'Tasks/Home.tasks', index)).toBe(true);
    expect(linksTo(makeTask({ notes: 'Details in [the plan](../Projects/Plan.md).' }), 'Projects/Plan.md', 'Tasks/Home.tasks', index)).toBe(true);
    expect(linksTo(makeTask({ notes: 'External [x](https://example.com/Apartment.md)' }), 'Apartment.md', 'Tasks/Home.tasks', index)).toBe(false);
    expect(linksTo(makeTask({ title: 'Embed ![[Apartment]]' }), 'Apartment.md', 'Tasks/Home.tasks', index)).toBe(false);
    expect(linksTo(makeTask({ title: 'Pay rent [[Apartment]]' }), 'Other.md', 'Tasks/Home.tasks', index)).toBe(false);
  });
});

describe('subtask trees', () => {
  const p = makeTask({ id: 'P', order: 'a0' });
  const c1 = makeTask({ id: 'C1', parentId: 'P', order: 'a1' });
  const c0 = makeTask({ id: 'C0', parentId: 'P', order: 'a0' });
  const g = makeTask({ id: 'G', parentId: 'C1', order: 'a0' });
  const orphan = makeTask({ id: 'O', parentId: 'missing', order: 'a1' });
  const all = [p, c1, c0, g, orphan];

  it('groups children in manual order and keeps orphans at the top level', () => {
    const children = childrenByParent(all);
    expect(children.get('P')?.map((t) => t.id)).toEqual(['C0', 'C1']);
    expect(children.get(null)?.map((t) => t.id)).toEqual(['P', 'O']);
    expect(descendants('P', children).map((t) => t.id)).toEqual(['C0', 'C1', 'G']);
    expect(subtreeHeight('P', children)).toBe(2);
    expect(subtreeHeight('G', children)).toBe(0);
    const byId = new Map(all.map((t) => [t.id, t]));
    expect(depthOf(g, byId)).toBe(2);
    expect(depthOf(orphan, byId)).toBe(0);
  });

  it('survives a parent cycle written by hand', () => {
    const a = makeTask({ id: 'A', parentId: 'B' });
    const b = makeTask({ id: 'B', parentId: 'A' });
    const byId = new Map([a, b].map((t) => [t.id, t]));
    expect(depthOf(a, byId)).toBeLessThan(3);
    expect(descendants('A', childrenByParent([a, b])).length).toBeLessThanOrEqual(1);
  });
});

describe('list rows', () => {
  const list = makeList({ sections: [makeSection('S2', 'Later', 'a1'), makeSection('S1', 'Errands', 'a0')] });
  const top = makeTask({ id: 'A', order: 'a0' });
  const sub = makeTask({ id: 'A1', parentId: 'A', order: 'a0' });
  const done = makeTask({ id: 'D', order: 'a1', status: 'done' });
  const doneParent = makeTask({ id: 'DP', order: 'a2', status: 'done' });
  const openChild = makeTask({ id: 'DC', parentId: 'DP', order: 'a0' });
  const inS1 = makeTask({ id: 'E', sectionId: 'S1', order: 'a0' });
  const lostSection = makeTask({ id: 'L', sectionId: 'gone', order: 'a3' });
  const other = makeTask({ id: 'X', listId: 'L2' });
  const tasks = [top, sub, done, doneParent, openChild, inS1, lostSection, other];
  const keys = (rows: ReturnType<typeof buildRows>) => rows.map((r) => (r.kind === 'section' ? `[${r.section?.name ?? ''}]` : `${'  '.repeat(r.depth)}${r.task.id}`));

  it('lays out sections in order, subtasks under parents, and hides closed tasks', () => {
    expect(keys(buildRows(list, tasks, { showCompleted: false, collapsed: new Set() }))).toEqual(['[]', 'A', '  A1', 'DP', '  DC', 'L', '[Errands]', 'E', '[Later]']);
  });

  it('shows closed tasks on request', () => {
    expect(keys(buildRows(list, tasks, { showCompleted: true, collapsed: new Set() }))).toEqual(['[]', 'A', '  A1', 'D', 'DP', '  DC', 'L', '[Errands]', 'E', '[Later]']);
  });

  it('collapses parents and sections', () => {
    const rows = buildRows(list, tasks, { showCompleted: false, collapsed: new Set(['A', 'section:S1']) });
    expect(keys(rows)).toEqual(['[]', 'A', 'DP', '  DC', 'L', '[Errands]', '[Later]']);
    const a = rows.find((r): r is TaskRow => r.kind === 'task' && r.task.id === 'A')!;
    expect(a.collapsed).toBe(true);
    expect(a.childCount).toBe(1);
  });
});
