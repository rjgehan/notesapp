import { describe, expect, it } from 'vitest';
import { buildRows, type TaskRow } from '../model';
import { makeList, makeSection, makeTask } from '../testing';
import { gapAt, indent, INDENT_PX, moveDown, moveUp, outdent, project, rowsWithout } from './drag';

// No section: A (A1 (A1a)), B, C. Section S1: D.
const list = makeList({ sections: [makeSection('S1', 'Errands', 'a0')] });
const A = makeTask({ id: 'A', order: 'a0' });
const A1 = makeTask({ id: 'A1', parentId: 'A', order: 'a0' });
const A1a = makeTask({ id: 'A1a', parentId: 'A1', order: 'a0' });
const B = makeTask({ id: 'B', order: 'a1' });
const C = makeTask({ id: 'C', order: 'a2' });
const D = makeTask({ id: 'D', sectionId: 'S1', order: 'a0' });
const tasks = [A, A1, A1a, B, C, D];
const rows = buildRows(list, tasks, { showCompleted: false, collapsed: new Set() });
const row = (id: string) => rows.find((r): r is TaskRow => r.kind === 'task' && r.task.id === id)!;

describe('drag projection (list page)', () => {
  it('leaves the dragged task and its subtasks out', () => {
    expect(rowsWithout(rows, 'A').map((r) => r.key)).toEqual(['section:', 'B', 'C', 'section:S1', 'D']);
  });

  it('drops C first at the top of the list', () => {
    const others = rowsWithout(rows, 'C');
    expect(project(others, 1, { task: C, depth: 0, height: 0 }, 0)).toMatchObject({ parentId: null, sectionId: null, afterId: null, depth: 0 });
    // Above the first section row there is no place.
    expect(project(others, 0, { task: C, depth: 0, height: 0 }, 0)).toBeNull();
  });

  it('makes C a subtask of B when dragged right, and a sibling otherwise', () => {
    const others = rowsWithout(rows, 'C');
    const gap = others.findIndex((r) => r.key === 'B') + 1;
    expect(project(others, gap, { task: C, depth: 0, height: 0 }, 0)).toMatchObject({ parentId: null, afterId: 'B', depth: 0 });
    expect(project(others, gap, { task: C, depth: 0, height: 0 }, INDENT_PX)).toMatchObject({ parentId: 'B', afterId: null, depth: 1 });
    // Further right is capped at one level below the task above.
    expect(project(others, gap, { task: C, depth: 0, height: 0 }, 5 * INDENT_PX)).toMatchObject({ depth: 1 });
  });

  it('lands under the right parent after a deeper subtree', () => {
    const others = rowsWithout(rows, 'C');
    const gap = others.findIndex((r) => r.key === 'A1a') + 1; // between A1a and B
    expect(project(others, gap, { task: C, depth: 0, height: 0 }, 2 * INDENT_PX)).toMatchObject({ parentId: 'A1', afterId: 'A1a', depth: 2 });
    expect(project(others, gap, { task: C, depth: 0, height: 0 }, INDENT_PX)).toMatchObject({ parentId: 'A', afterId: 'A1', depth: 1 });
    expect(project(others, gap, { task: C, depth: 0, height: 0 }, 0)).toMatchObject({ parentId: null, afterId: 'A', depth: 0 });
  });

  it('keeps three levels with the dragged subtree', () => {
    // A1 has one level below it, so it can be at most at depth 1.
    const others = rowsWithout(rows, 'A1');
    const gap = others.findIndex((r) => r.key === 'B') + 1;
    expect(project(others, gap, { task: A1, depth: 1, height: 1 }, 3 * INDENT_PX)).toMatchObject({ depth: 1, parentId: 'B' });
    // Between A and its subtree A1a (gone with A1) nothing deeper than 1 fits: minDepth 0.
    const A2 = makeTask({ id: 'A2', parentId: 'A', order: 'a1' });
    const deep = buildRows(list, [...tasks, A2], { showCompleted: false, collapsed: new Set() });
    const rest = rowsWithout(deep, 'A');
    expect(project(rest, rest.findIndex((r) => r.key === 'C') + 1, { task: A, depth: 0, height: 2 }, INDENT_PX)).toMatchObject({ depth: 0 });
  });

  it('moves into a section after its header', () => {
    const others = rowsWithout(rows, 'B');
    const gap = others.findIndex((r) => r.key === 'section:S1') + 1;
    expect(project(others, gap, { task: B, depth: 0, height: 0 }, 2 * INDENT_PX)).toMatchObject({ parentId: null, sectionId: 'S1', afterId: null, depth: 0 });
    expect(project(others, others.length, { task: B, depth: 0, height: 0 }, 0)).toMatchObject({ sectionId: 'S1', afterId: 'D' });
  });

  it('finds the gap from row midpoints', () => {
    expect(gapAt([10, 30, 50], 5)).toBe(0);
    expect(gapAt([10, 30, 50], 31)).toBe(2);
    expect(gapAt([10, 30, 50], 99)).toBe(3);
  });
});

describe('keyboard moves', () => {
  it('moves among siblings', () => {
    expect(moveUp(A, tasks)).toBeNull();
    expect(moveUp(C, tasks)).toEqual({ parentId: null, sectionId: null, afterId: 'A' });
    expect(moveUp(B, tasks)).toEqual({ parentId: null, sectionId: null, afterId: null });
    expect(moveDown(B, tasks)).toEqual({ parentId: null, sectionId: null, afterId: 'C' });
    expect(moveDown(C, tasks)).toBeNull();
    // D is alone in its section.
    expect(moveDown(D, tasks)).toBeNull();
  });

  it('indents under the previous sibling within the depth limit, and outdents after the parent', () => {
    expect(indent(C, tasks)).toEqual({ parentId: 'B', sectionId: null, afterId: null });
    expect(indent(B, tasks)).toEqual({ parentId: 'A', sectionId: null, afterId: 'A1' });
    expect(indent(A, tasks)).toBeNull();
    const A2 = makeTask({ id: 'A2', parentId: 'A1', order: 'a1' });
    // A2 is already at depth 2 under A1, after A1a: indenting would make depth 3.
    expect(indent(A2, [...tasks, A2])).toBeNull();
    expect(outdent(A1a, tasks)).toEqual({ parentId: 'A', sectionId: null, afterId: 'A1' });
    expect(outdent(A1, tasks)).toEqual({ parentId: null, sectionId: null, afterId: 'A' });
    expect(outdent(A, tasks)).toBeNull();
  });

  it('records the row depth used by the projection', () => {
    expect(row('A1a').depth).toBe(2);
  });
});
