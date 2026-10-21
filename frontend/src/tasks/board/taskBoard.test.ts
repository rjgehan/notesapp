import { describe, expect, it } from 'vitest';
import { makeList, makeSection, makeTask } from '../testing';
import { actionFor, NO_SECTION, sectionColumnId, statusColumnId, taskColumns } from './taskBoard';

const list = makeList({ sections: [makeSection('S2', 'Later', 'a1'), makeSection('S1', 'Errands', 'a0')] });
const tasks = [
  makeTask({ id: 'A', title: 'Plan', order: 'a0' }),
  makeTask({ id: 'A1', title: 'Sub', parentId: 'A', order: 'a0' }),
  makeTask({ id: 'B', title: 'Milk', sectionId: 'S1', order: 'a0' }),
  makeTask({ id: 'C', title: 'Bread', sectionId: 'S1', order: 'a1' }),
  makeTask({ id: 'D', title: 'Old', sectionId: 'S1', order: 'a2', status: 'done', completedAt: '2026-10-01T10:00:00Z' }),
  makeTask({ id: 'E', title: 'Newer', status: 'done', order: 'a3', completedAt: '2026-10-05T10:00:00Z' }),
  makeTask({ id: 'X', title: 'Dropped', status: 'cancelled', order: 'a4', completedAt: '2026-10-03T10:00:00Z' }),
  makeTask({ id: 'Z', title: 'Elsewhere', listId: 'L2' }),
  makeTask({ id: 'Q', title: 'Archived', archived: true, status: 'done' }),
];
const titles = (cols: ReturnType<typeof taskColumns>) => cols.map((c) => `${c.title}: ${c.tasks.map((t) => t.id).join(',')}`);

describe('a list as a board', () => {
  it('has a column per section, in order, after the tasks without one; cards are top-level tasks', () => {
    expect(titles(taskColumns(list, tasks, 'section', false))).toEqual(['No section: A', 'Errands: B,C', 'Later: ']);
    expect(titles(taskColumns(list, tasks, 'section', true))).toEqual(['No section: A,E,X', 'Errands: B,C,D', 'Later: ']);
  });

  it('leaves out an empty "No section" column, unless the list has no sections', () => {
    expect(taskColumns(list, tasks.filter((t) => t.sectionId !== null), 'section', false).map((c) => c.id)).toEqual([sectionColumnId('S1'), sectionColumnId('S2')]);
    expect(titles(taskColumns(makeList(), [], 'section', false))).toEqual(['Tasks: ']);
  });

  it('keeps a closed task whose subtask is still open', () => {
    const closedParent = [makeTask({ id: 'P', status: 'done', completedAt: '2026-10-01T00:00:00Z' }), makeTask({ id: 'P1', parentId: 'P' })];
    expect(titles(taskColumns(makeList(), closedParent, 'section', false))).toEqual(['Tasks: P']);
  });

  it('by status: To do in the list’s order, then Done and Cancelled by completion, newest first', () => {
    expect(titles(taskColumns(list, tasks, 'status', false))).toEqual(['To do: A,B,C', 'Done: E,D', 'Cancelled: X']);
    // Cancelled shows even when empty, as the place to drop a task to cancel it.
    expect(taskColumns(list, tasks.filter((t) => t.status !== 'cancelled'), 'status', false).map((c) => c.id)).toEqual([statusColumnId('open'), statusColumnId('done'), statusColumnId('cancelled')]);
  });
});

describe('what a move on the board means', () => {
  const bySection = taskColumns(list, tasks, 'section', false);
  const byStatus = taskColumns(list, tasks, 'status', false);

  it('between and within sections, places the card after the one it now follows', () => {
    expect(actionFor({ itemKey: 'A', from: NO_SECTION, to: sectionColumnId('S1'), index: 1 }, bySection)).toMatchObject({
      kind: 'place',
      task: { id: 'A' },
      placement: { parentId: null, sectionId: 'S1', afterId: 'B' },
    });
    expect(actionFor({ itemKey: 'C', from: sectionColumnId('S1'), to: sectionColumnId('S1'), index: 0 }, bySection)).toMatchObject({
      placement: { parentId: null, sectionId: 'S1', afterId: null },
    });
    expect(actionFor({ itemKey: 'B', from: sectionColumnId('S1'), to: sectionColumnId('S2'), index: 5 }, bySection)).toMatchObject({
      placement: { sectionId: 'S2', afterId: null },
    });
  });

  it('into a status column, sets that status', () => {
    expect(actionFor({ itemKey: 'B', from: statusColumnId('open'), to: statusColumnId('done'), index: 0 }, byStatus)).toMatchObject({ kind: 'status', status: 'done', task: { id: 'B' } });
    expect(actionFor({ itemKey: 'E', from: statusColumnId('done'), to: statusColumnId('open'), index: 2 }, byStatus)).toMatchObject({ kind: 'status', status: 'open' });
    expect(actionFor({ itemKey: 'E', from: statusColumnId('done'), to: statusColumnId('cancelled'), index: 0 }, byStatus)).toMatchObject({ kind: 'status', status: 'cancelled' });
  });

  it('within To do, takes the section of its new neighbour; within Done, changes nothing', () => {
    expect(actionFor({ itemKey: 'A', from: statusColumnId('open'), to: statusColumnId('open'), index: 2 }, byStatus)).toMatchObject({
      placement: { parentId: null, sectionId: 'S1', afterId: 'C' },
    });
    expect(actionFor({ itemKey: 'C', from: statusColumnId('open'), to: statusColumnId('open'), index: 0 }, byStatus)).toMatchObject({
      placement: { parentId: null, sectionId: null, afterId: null },
    });
    expect(actionFor({ itemKey: 'E', from: statusColumnId('done'), to: statusColumnId('done'), index: 1 }, byStatus)).toBeNull();
    expect(actionFor({ itemKey: 'missing', from: statusColumnId('open'), to: statusColumnId('done'), index: 0 }, byStatus)).toBeNull();
  });
});
