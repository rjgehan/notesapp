// The Kanban view of a list (ROADMAP item 4): its sections, or the task statuses, as the columns
// of the generic Board, with a card per top-level task. Moves become the same writes as on the
// list page (reorder with the section; complete, reopen or cancel), optimistic and undoable.
import { ArrowRightLeft, Ban, Ellipsis, ListPlus, Maximize2, Plus, SquareSplitVertical, Trash2 } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';
import type { Task, TaskList, TaskSection, TaskStatus } from '../../api/types';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';
import { Board, type BoardColumn, type BoardMove } from '../board/Board';
import { actionFor, taskColumns, type BoardGroup, type TaskColumn } from '../board/taskBoard';
import { childrenByParent, isClosed } from '../model';
import { cancelTask, deleteTask, isPending, moveTask, setTaskStatus } from '../mutations';
import { TaskCheck, TaskMeta, TaskTitle } from './parts';
import { openQuickAdd, openTaskDetail } from './state';

interface Props {
  list: TaskList;
  tasks: readonly Task[];
  group: BoardGroup;
  showCompleted: boolean;
  readOnly: boolean;
  today: string;
  onSectionMenu(e: MouseEvent, section: TaskSection): void;
  onAddSection(): void;
}

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
}

const STATUS_NAMES: Record<TaskStatus, string> = { open: 'To do', done: 'Done', cancelled: 'Cancelled' };

function TaskCard({ task, list, today, subtasks, readOnly, onMenu }: { task: Task; list: TaskList; today: string; subtasks?: { done: number; total: number }; readOnly: boolean; onMenu(e: MouseEvent, task: Task): void }) {
  const pending = isPending(task);
  const open = () => !pending && openTaskDetail(task.id);
  return (
    <div className={`task-card${isClosed(task) ? ' is-closed' : ''}${pending ? ' is-pending' : ''}`} data-task-id={task.id}>
      <TaskCheck task={task} disabled={readOnly && !task.archived} />
      <div className="task-card-main" onClick={open}>
        <span className="task-title">
          <TaskTitle task={task} listPath={list.path} />
        </span>
        <TaskMeta task={task} today={today} subtasks={subtasks} />
      </div>
      <button type="button" className="icon-button task-card-more" aria-label={`More for “${task.title}”`} title="More" aria-haspopup="menu" disabled={pending} onClick={(e) => onMenu(e, task)}>
        <Ellipsis size={16} />
      </button>
    </div>
  );
}

export function TaskBoard({ list, tasks, group, showCompleted, readOnly, today, onSectionMenu, onAddSection }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const columns = useMemo(() => taskColumns(list, tasks, group, showCompleted), [list, tasks, group, showCompleted]);
  const children = useMemo(() => childrenByParent(tasks.filter((t) => t.listId === list.id && !t.archived)), [tasks, list.id]);

  const subtaskCounts = (taskId: string) => {
    const kids = children.get(taskId);
    return kids?.length ? { done: kids.filter(isClosed).length, total: kids.length } : undefined;
  };

  const apply = (move: BoardMove) => {
    const action = actionFor(move, columns);
    if (!action) return;
    if (action.kind === 'place') void moveTask(action.task, action.placement);
    else setTaskStatus(action.task, action.status);
  };

  const cardMenu = (e: MouseEvent, task: Task) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuEntry[] = [{ id: 'details', label: 'Details', icon: <Maximize2 size={16} />, run: () => openTaskDetail(task.id) }];
    if (!readOnly) {
      const here = columns.find((c) => c.tasks.some((t) => t.id === task.id));
      for (const c of columns) {
        if (c.id === here?.id) continue;
        items.push({
          id: `to-${c.id}`,
          label: group === 'section' ? `Move to “${c.title}”` : `Mark as ${STATUS_NAMES[c.status!].toLowerCase()}`,
          icon: group === 'section' ? <SquareSplitVertical size={16} /> : <ArrowRightLeft size={16} />,
          run: () => apply({ itemKey: task.id, from: here?.id ?? '', to: c.id, index: c.tasks.length }),
        });
      }
      // By status, Cancelled is one of the columns above.
      if (group === 'section' && task.status === 'open') items.push({ id: 'cancel', label: 'Cancel task', icon: <Ban size={16} />, run: () => void cancelTask(task) });
      items.push('separator', { id: 'delete', label: 'Delete…', icon: <Trash2 size={16} />, danger: true, run: () => void deleteTask(task) });
    }
    setMenu({ x: rect.left, y: rect.bottom + 4, label: `${task.title} actions`, items });
  };

  const boardColumns: Array<BoardColumn<Task>> = columns.map((c: TaskColumn) => {
    const section = c.sectionId ? list.sections.find((s) => s.id === c.sectionId) : undefined;
    const add = () => openQuickAdd({ listId: list.id, sectionId: c.sectionId ?? null });
    return {
      id: c.id,
      title: c.title,
      items: c.tasks,
      accent: c.status === 'done' ? 'var(--text-success)' : c.status === 'cancelled' ? 'var(--text-faint)' : null,
      actions:
        !readOnly && group === 'section' ? (
          <span className="board-column-actions">
            <button type="button" className="icon-button" aria-label={`Add task to ${c.title}`} title="Add task" onClick={add}>
              <Plus size={16} />
            </button>
            {section && (
              <button type="button" className="icon-button" aria-label={`More for section ${section.name}`} title="More" aria-haspopup="menu" onClick={(e) => onSectionMenu(e, section)}>
                <Ellipsis size={16} />
              </button>
            )}
          </span>
        ) : undefined,
      footer:
        !readOnly && (group === 'section' || c.status === 'open') ? (
          <button type="button" className="board-add" onClick={add}>
            <Plus size={14} aria-hidden /> Add task
          </button>
        ) : undefined,
      empty: <span className="muted">{c.status === 'open' ? 'Nothing to do' : c.status ? 'None yet' : 'No tasks'}</span>,
    };
  });

  return (
    <>
      <Board
        label={`${list.name} board`}
        columns={boardColumns}
        itemKey={(t) => t.id}
        itemLabel={(t) => t.title}
        canDrag={(t) => !readOnly && !isPending(t)}
        onMove={apply}
        onOpen={(t) => !isPending(t) && openTaskDetail(t.id)}
        renderCard={(t) => <TaskCard task={t} list={list} today={today} subtasks={subtaskCounts(t.id)} readOnly={readOnly} onMenu={cardMenu} />}
        trailing={
          !readOnly && group === 'section' ? (
            <button type="button" className="board-add-column" onClick={onAddSection}>
              <ListPlus size={14} aria-hidden /> Add section
            </button>
          ) : undefined
        }
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
