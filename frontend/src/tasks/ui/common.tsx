// Pieces shared by the task pages and the note panel.
import { ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { errorMessage } from '../../api/client';
import type { LocalDate, Task, TaskFileProblem } from '../../api/types';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { openPath } from '../../features/navigation';
import { displayName } from '../../features/paths';
import { isClosed } from '../model';
import { isPending } from '../mutations';
import type { TaskData } from './useTaskData';
import { TaskCheck, TaskMeta, TaskTitle } from './parts';
import { openTaskDetail } from './state';

/** A row of a flat view (Today, the note panel): check, title, meta; a tap opens the details. */
export function FlatTaskRow({ task, today, data, showList = true }: { task: Task; today: LocalDate; data: TaskData; showList?: boolean }) {
  const list = data.listMap.get(task.listId);
  const parent = task.parentId ? data.tasks.get(task.parentId) : undefined;
  const pending = isPending(task);
  const open = () => !pending && openTaskDetail(task.id);
  return (
    <li className={`task-row${isClosed(task) ? ' is-closed' : ''}${pending ? ' is-pending' : ''}`} data-task-id={task.id}>
      <TaskCheck task={task} />
      <div className="task-row-body" onClick={open}>
        <span className="task-title">
          <TaskTitle task={task} listPath={list?.path ?? ''} />
        </span>
        <TaskMeta task={task} today={today} list={showList ? list : undefined} parentTitle={parent?.title} />
      </div>
      <button type="button" className="icon-button task-row-open" aria-label={`Open “${task.title}”`} title="Details" disabled={pending} onClick={open}>
        <ChevronRight size={16} />
      </button>
    </li>
  );
}

/** Files that could not be read as task lists, or tasks that were skipped (API.md §20.1). */
export function TaskProblems({ problems, only }: { problems: readonly TaskFileProblem[]; only?: string }) {
  const shown = problems.filter((p) => only === undefined || p.path === only);
  if (shown.length === 0) return null;
  return (
    <div className="banner banner-warning task-problems" role="note">
      <TriangleAlert size={14} aria-hidden />
      <div>
        <p className="task-problems-title">{shown.length === 1 ? 'A task file has a problem' : `${shown.length} task files have problems`}; nothing in them was changed.</p>
        <ul>
          {shown.map((p, i) => (
            <li key={`${p.path}-${p.taskId ?? ''}-${i}`}>
              <button type="button" className="link-button" onClick={() => openPath(p.path)}>
                {displayName(p.path)}
              </button>
              {p.taskId ? ` (task ${p.taskId})` : ''}: {p.reason}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LoadError({ error, retry }: { error: unknown; retry(): void }) {
  return (
    <div className="error-panel" role="alert">
      <p className="error-panel-title">The tasks could not be loaded.</p>
      <p className="error-panel-detail">{errorMessage(error)}</p>
      <button type="button" className="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function Loading() {
  return (
    <div className="view-loading" aria-busy="true">
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
    </div>
  );
}

/** The floating "+" of phones and tablets, above the home indicator. */
export function TaskFab({ onClick, label = 'Add task' }: { onClick(): void; label?: string }) {
  const breakpoint = useBreakpoint();
  if (breakpoint === 'desktop') return null;
  return (
    <button type="button" className="task-fab" aria-label={label} title={label} onClick={onClick}>
      <Plus size={26} aria-hidden />
    </button>
  );
}
