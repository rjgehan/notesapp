// Drag to reorder on a list page: where a dragged task lands, from the gap the pointer is over and
// how far it moved sideways (the projection of a sortable tree). The dragged task moves with its
// subtasks; it can become a subtask of the task above (at most three levels with its own
// subtasks) or move into another section. Pure, so it is tested without a DOM.
import type { Task } from '../../api/types';
import { childrenByParent, compareOrder, depthOf, MAX_DEPTH, subtreeHeight, type ListRow } from '../model';
import type { Placement } from '../mutations';

/** Horizontal pixels per level of nesting. */
export const INDENT_PX = 24;

export interface Projection extends Placement {
  depth: number;
  /** Index in `rows` (without the dragged rows) of the gap: the drop goes before `rows[gap]`. */
  gap: number;
}

/** The rows that stay put while `task` is dragged: everything but the task and its subtasks. */
export function rowsWithout(rows: readonly ListRow[], taskId: string): ListRow[] {
  const at = rows.findIndex((r) => r.kind === 'task' && r.task.id === taskId);
  if (at < 0) return [...rows];
  const start = rows[at] as Extract<ListRow, { kind: 'task' }>;
  let end = at + 1;
  while (end < rows.length) {
    const r = rows[end];
    if (r.kind !== 'task' || r.depth <= start.depth) break;
    end++;
  }
  return [...rows.slice(0, at), ...rows.slice(end)];
}

/**
 * Where the dragged task lands in gap `gap` of `rows` (the rows without it), `dx` pixels right of
 * where the drag started. `height` is its levels of subtasks (0 without). Null when it cannot go
 * there (too deep) or the gap is above the first section.
 */
export function project(rows: readonly ListRow[], gap: number, dragged: { task: Task; depth: number; height: number }, dx: number): Projection | null {
  if (gap <= 0 || gap > rows.length) return null;
  const prev = rows[gap - 1];
  const next = rows[gap] as ListRow | undefined;
  const sectionId = prev.kind === 'section' ? (prev.section?.id ?? null) : prev.sectionId;
  const maxDepth = Math.min(prev.kind === 'task' ? prev.depth + 1 : 0, MAX_DEPTH - dragged.height);
  const minDepth = next && next.kind === 'task' ? next.depth : 0;
  if (maxDepth < minDepth) return null;
  const wanted = dragged.depth + Math.round(dx / INDENT_PX);
  const depth = Math.max(minDepth, Math.min(maxDepth, wanted));

  // The parent is the nearest task above at depth - 1; the sibling to follow, the nearest at depth.
  let parentId: string | null = null;
  let afterId: string | null = null;
  for (let i = gap - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'section') break;
    if (r.depth === depth && afterId === null) afterId = r.task.id;
    if (r.depth < depth) {
      parentId = r.task.id;
      break;
    }
  }
  if (depth === 0) parentId = null;
  return { gap, depth, parentId, sectionId: depth === 0 ? sectionId : null, afterId };
}

/**
 * The gap under a pointer at `y`, from the rows' vertical midpoints (`mids[i]` is the middle of
 * `rows[i]`, the dragged rows left out): the drop goes before the first row whose middle is below.
 */
export function gapAt(mids: readonly number[], y: number): number {
  let gap = 0;
  while (gap < mids.length && y > mids[gap]) gap++;
  return gap;
}

// ---------- keyboard and menu moves (the same reorder, one step at a time) ----------

function siblingsOf(task: Task, tasks: Iterable<Task>): Task[] {
  return [...tasks]
    .filter((t) => t.listId === task.listId && !t.archived && t.parentId === task.parentId && (task.parentId !== null || t.sectionId === task.sectionId))
    .sort(compareOrder);
}

/** Before the previous sibling. */
export function moveUp(task: Task, tasks: Iterable<Task>): Placement | null {
  const sibs = siblingsOf(task, tasks);
  const i = sibs.findIndex((t) => t.id === task.id);
  if (i <= 0) return null;
  return { parentId: task.parentId, sectionId: task.sectionId, afterId: i >= 2 ? sibs[i - 2].id : null };
}

/** After the next sibling. */
export function moveDown(task: Task, tasks: Iterable<Task>): Placement | null {
  const sibs = siblingsOf(task, tasks);
  const i = sibs.findIndex((t) => t.id === task.id);
  if (i < 0 || i >= sibs.length - 1) return null;
  return { parentId: task.parentId, sectionId: task.sectionId, afterId: sibs[i + 1].id };
}

/** Last subtask of the previous sibling, when the depth allows it. */
export function indent(task: Task, tasks: Iterable<Task>): Placement | null {
  const all = [...tasks];
  const sibs = siblingsOf(task, all);
  const i = sibs.findIndex((t) => t.id === task.id);
  if (i <= 0) return null;
  const parent = sibs[i - 1];
  const byId = new Map(all.map((t) => [t.id, t]));
  const children = childrenByParent(all.filter((t) => t.listId === task.listId && !t.archived));
  if (depthOf(parent, byId) + 1 + subtreeHeight(task.id, children) > MAX_DEPTH) return null;
  const last = (children.get(parent.id) ?? []).at(-1);
  return { parentId: parent.id, sectionId: null, afterId: last?.id ?? null };
}

/** Right after its parent, one level up. */
export function outdent(task: Task, tasks: Iterable<Task>): Placement | null {
  if (task.parentId === null) return null;
  const parent = [...tasks].find((t) => t.id === task.parentId);
  if (!parent) return null;
  return { parentId: parent.parentId, sectionId: parent.parentId === null ? parent.sectionId : null, afterId: parent.id };
}
