// `![[Home.tasks]]` in a note (ROADMAP item 4, "Integration with notes"): the list, live and
// interactive, through the view registry's `loadEmbed` (the reading view's embed hydration, and
// Live Preview's embed widgets, mount it in a React root of its own, outside the router). Checking
// a task completes it through the task API, exactly as on the list page; a title opens the task's
// details; a task can be added at the bottom. `![[Home.tasks#Errands]]` shows one section, and
// `![[Home.tasks#^<task id>]]` one task with its subtasks.
import { ListTodo, Plus } from 'lucide-react';
import { useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Task } from '../../api/types';
import { openPath } from '../../features/navigation';
import { displayName, noteRoute } from '../../features/paths';
import type { EmbedProps } from '../../views/registry';
import { useToday } from '../dates';
import { buildRows, childrenByParent, depthOf, isClosed, MAX_DEPTH, type ListRow, type TaskRow } from '../model';
import { createTask, isPending } from '../mutations';
import { listParams, useTaskLists, useTaskView } from '../queries';
import { linkedTaskId } from '../taskLinks';
import { useTaskData } from './useTaskData';
import { ListDot, TaskCheck, TaskMeta, TaskTitle } from './parts';
import { openTaskDetail } from './state';

const NOTHING_COLLAPSED = new Set<string>();

function EmbedRow({ row, listPath, today, readOnly }: { row: TaskRow; listPath: string; today: string; readOnly: boolean }) {
  const { task } = row;
  const open = () => !isPending(task) && openTaskDetail(task.id);
  return (
    <li className={`task-row is-tree${isClosed(task) ? ' is-closed' : ''}${isPending(task) ? ' is-pending' : ''}`} style={{ '--task-depth': row.depth } as CSSProperties} data-task-id={task.id}>
      <TaskCheck task={task} disabled={readOnly && !task.archived} />
      <div className="task-row-body" onClick={open}>
        <span className="task-title">
          <TaskTitle task={task} listPath={listPath} />
        </span>
        <TaskMeta task={task} today={today} />
      </div>
    </li>
  );
}

function AddTask({ listId, sectionId, parentId }: { listId: string; sectionId: string | null; parentId?: string }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className="task-embed-add"
      onSubmit={(e) => {
        e.preventDefault();
        const t = title.replace(/\s+/g, ' ').trim();
        if (!t) return;
        setTitle('');
        void createTask(parentId ? { title: t, parentId } : { title: t, listId, sectionId });
      }}
    >
      <Plus size={15} aria-hidden />
      <input
        className="text-input"
        aria-label={parentId ? 'Add subtask' : 'Add task'}
        placeholder={parentId ? 'Add subtask…' : 'Add task…'}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        enterKeyHint="done"
        maxLength={500}
      />
    </form>
  );
}

/** One task and its subtasks as rows, from depth 0 (closed subtasks only when `showDone`). */
function subtreeRows(top: Task, own: readonly Task[], showDone: boolean): TaskRow[] {
  const children = childrenByParent(own);
  const rows: TaskRow[] = [];
  const walk = (t: Task, depth: number, guard: Set<string>) => {
    if (guard.has(t.id)) return;
    guard.add(t.id);
    const kids = (children.get(t.id) ?? []).filter((c) => showDone || !isClosed(c));
    rows.push({ kind: 'task', key: t.id, task: t, depth, sectionId: t.sectionId, childCount: kids.length, collapsed: false });
    for (const c of kids) walk(c, depth + 1, guard);
  };
  walk(top, 0, new Set());
  return rows;
}

export default function TaskListEmbed({ path, subpath, display }: EmbedProps) {
  const today = useToday();
  const lists = useTaskLists();
  const data = useTaskData();
  const list = data.lists.find((l) => l.path === path);
  const view = useTaskView(listParams(list?.id ?? ''), list !== undefined);
  const [showDone, setShowDone] = useState(false);
  const taskId = linkedTaskId(subpath);
  const sectionName = subpath && !taskId ? subpath.replace(/^#/, '') : null;

  const own = useMemo(() => (list ? [...data.tasks.values()].filter((t) => t.listId === list.id && !t.archived) : []), [data, list]);
  const top = taskId ? own.find((t) => t.id === taskId) : undefined;
  const section = sectionName && list ? list.sections.find((s) => s.name.toLowerCase() === sectionName.toLowerCase()) : undefined;

  /** The rows in scope (the list with its section headings, one section, or one task), with or without the closed ones. */
  const scoped = (withDone: boolean): ListRow[] => {
    if (!list) return [];
    if (top) return subtreeRows(top, own, withDone);
    const rows = buildRows(list, own, { showCompleted: withDone, collapsed: NOTHING_COLLAPSED });
    if (section) return rows.filter((r) => r.kind === 'task' && r.sectionId === section.id);
    // Sections show as headings, the empty ones left out.
    return rows.filter((r) => r.kind === 'task' || (r.section !== null && r.count > 0));
  };
  const rows = scoped(showDone);
  const closed = scoped(true).filter((r) => r.kind === 'task' && isClosed(r.task)).length;
  const taskCount = rows.filter((r) => r.kind === 'task').length;

  const openList = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openPath(path);
  };
  const title = display ?? (list ? list.name + (section ? ` › ${section.name}` : '') : displayName(path));
  const head = (
    <a className="task-embed-title" href={noteRoute(path)} onClick={openList}>
      {list ? <ListDot list={list} /> : <ListTodo size={14} aria-hidden />}
      <span>{title}</span>
    </a>
  );

  if (!list) {
    const problem = (lists.data?.problems ?? []).find((p) => p.path === path && p.taskId === null);
    return (
      <div className="task-embed" data-source={path}>
        <header className="task-embed-head">{head}</header>
        <p className="task-embed-empty">
          {lists.isPending ? 'Loading…' : problem ? `This task list cannot be read: ${problem.reason}.` : lists.isError ? 'The tasks could not be loaded.' : 'Not a task list.'}
        </p>
      </div>
    );
  }

  const readOnly = !list.writable;
  const missing = (taskId !== null && !top) || (sectionName !== null && !section);
  const loading = view.isPending && own.length === 0;
  const canAddSubtask = top !== undefined && depthOf(top, data.tasks) < MAX_DEPTH;

  return (
    <div className="task-embed" data-source={path}>
      <header className="task-embed-head">
        {head}
        {closed > 0 && (
          <button type="button" className="link-button task-embed-toggle" aria-pressed={showDone} onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide completed' : `Show completed (${closed})`}
          </button>
        )}
      </header>
      {loading ? (
        <p className="task-embed-empty">Loading…</p>
      ) : missing ? (
        <p className="task-embed-empty">{taskId ? 'This task is not in this list any more.' : `No section “${sectionName}” in this list.`}</p>
      ) : taskCount === 0 ? (
        <p className="task-embed-empty">{closed > 0 ? 'All done.' : 'No tasks yet.'}</p>
      ) : (
        <ul className="task-list task-tree is-compact" aria-label={title}>
          {rows.map((r) =>
            r.kind === 'task' ? (
              <EmbedRow key={r.key} row={r} listPath={list.path} today={today} readOnly={readOnly} />
            ) : (
              <li key={r.key} className="task-embed-section">
                {r.section?.name}
              </li>
            ),
          )}
        </ul>
      )}
      {!readOnly && !loading && !missing && (top ? canAddSubtask && <AddTask listId={list.id} sectionId={null} parentId={top.id} /> : <AddTask listId={list.id} sectionId={section?.id ?? null} />)}
    </div>
  );
}
