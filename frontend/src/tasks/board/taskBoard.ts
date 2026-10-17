// A task list as a board (ROADMAP item 4, Kanban view): the columns are the list's sections, or
// the task statuses, and the cards are its top-level tasks (subtasks are counted on their card).
// Pure: which cards go in which column, and what a move of a card means as a task write.
import type { Task, TaskList, TaskStatus } from '../../api/types';
import { childrenByParent, compareCompleted, compareOrder, descendants, isClosed, sortSections } from '../model';
import type { Placement } from '../mutations';
import type { BoardMove } from './boardDrag';

export type BoardGroup = 'section' | 'status';

export interface TaskColumn {
  id: string;
  title: string;
  tasks: Task[];
  /** Section columns: the section (null: tasks without one). */
  sectionId?: string | null;
  /** Status columns: the status the column stands for. */
  status?: TaskStatus;
}

export const NO_SECTION = 'section:';
export const sectionColumnId = (sectionId: string | null) => `section:${sectionId ?? ''}`;
export const statusColumnId = (status: TaskStatus) => `status:${status}`;

/** The top-level tasks of a list, in order, with the closed ones only when asked (or when they still have open subtasks). */
function topLevel(list: TaskList, tasks: readonly Task[], showCompleted: boolean): Task[] {
  const own = tasks.filter((t) => t.listId === list.id && !t.archived);
  const children = childrenByParent(own);
  const openBelow = (t: Task) => descendants(t.id, children).some((d) => !isClosed(d));
  return (children.get(null) ?? []).filter((t) => showCompleted || !isClosed(t) || openBelow(t));
}

/**
 * The columns of a list's board. By section: tasks without a section first (only when there are
 * some, or no sections at all), then each section, in order. By status: To do in the list's own
 * order (section by section), then Done and Cancelled by completion time, newest first.
 */
export function taskColumns(list: TaskList, tasks: readonly Task[], group: BoardGroup, showCompleted: boolean): TaskColumn[] {
  const sections = sortSections(list.sections);
  if (group === 'section') {
    const top = topLevel(list, tasks, showCompleted);
    const known = new Set(sections.map((s) => s.id));
    const sectionOf = (t: Task) => (t.sectionId !== null && known.has(t.sectionId) ? t.sectionId : null);
    const none = top.filter((t) => sectionOf(t) === null);
    const columns: TaskColumn[] = sections.map((s) => ({ id: sectionColumnId(s.id), title: s.name, sectionId: s.id, tasks: top.filter((t) => sectionOf(t) === s.id) }));
    if (none.length > 0 || sections.length === 0) columns.unshift({ id: NO_SECTION, title: sections.length === 0 ? 'Tasks' : 'No section', sectionId: null, tasks: none });
    return columns;
  }
  const rank = new Map<string | null, number>([[null, -1], ...sections.map((s, i): [string, number] => [s.id, i])]);
  const sectionRank = (t: Task) => rank.get(t.sectionId) ?? -1;
  const top = topLevel(list, tasks, true);
  const open = top.filter((t) => t.status === 'open').sort((a, b) => sectionRank(a) - sectionRank(b) || compareOrder(a, b));
  const done = top.filter((t) => t.status === 'done').sort(compareCompleted);
  const cancelled = top.filter((t) => t.status === 'cancelled').sort(compareCompleted);
  const columns: TaskColumn[] = [
    { id: statusColumnId('open'), title: 'To do', status: 'open', tasks: open },
    { id: statusColumnId('done'), title: 'Done', status: 'done', tasks: done },
  ];
  if (cancelled.length > 0) columns.push({ id: statusColumnId('cancelled'), title: 'Cancelled', status: 'cancelled', tasks: cancelled });
  return columns;
}

export type TaskBoardAction = { kind: 'place'; task: Task; placement: Placement } | { kind: 'status'; task: Task; status: TaskStatus } | null;

/**
 * What a move on the board means. Between section columns, and within one, the card takes its
 * new place (POST /api/tasks/reorder with the section). Into a status column, the task gets that
 * status (completed, reopened or cancelled); within To do it takes its place in the list's order,
 * in the section of the card it now follows (or precedes, at the top). Done and Cancelled are
 * ordered by completion time, so a move within them changes nothing.
 */
export function actionFor(move: BoardMove, columns: readonly TaskColumn[]): TaskBoardAction {
  const from = columns.find((c) => c.id === move.from);
  const to = columns.find((c) => c.id === move.to);
  const task = from?.tasks.find((t) => t.id === move.itemKey);
  if (!from || !to || !task) return null;
  const others = to.tasks.filter((t) => t.id !== task.id);
  const prev = move.index > 0 ? others[Math.min(move.index, others.length) - 1] : undefined;
  if (to.status === undefined) {
    return { kind: 'place', task, placement: { parentId: null, sectionId: to.sectionId ?? null, afterId: prev?.id ?? null } };
  }
  if (from.id !== to.id) return task.status === to.status ? null : { kind: 'status', task, status: to.status };
  if (to.status !== 'open') return null;
  if (prev) return { kind: 'place', task, placement: { parentId: null, sectionId: prev.sectionId, afterId: prev.id } };
  const next = others[0];
  return next ? { kind: 'place', task, placement: { parentId: null, sectionId: next.sectionId, afterId: null } } : null;
}
