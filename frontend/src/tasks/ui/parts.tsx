// Small pieces shared by the task views: the check circle, the title with its links and tags, and
// the meta line (date, recurrence, priority, list, tags, subtasks).
import { Flag, Link2, ListTree, Repeat, StickyNote } from 'lucide-react';
import type { MouseEvent } from 'react';
import { useTree } from '../../api/hooks';
import type { LocalDate, Task, TaskList } from '../../api/types';
import { resolve } from '../../features/links';
import { openLink, openTag } from '../../features/navigation';
import { useUi } from '../../state/ui';
import { dateTone, formatTaskDate } from '../dates';
import { PRIORITY_NAMES, taskTags } from '../model';
import { isPending, toggleTask } from '../mutations';
import { recurrenceText } from '../recurrence';
import { listColor, titleSegments } from './display';

export function ListDot({ list }: { list: TaskList | undefined }) {
  const color = listColor(list);
  return <span className="task-list-dot" style={color ? { background: color } : undefined} aria-hidden />;
}

export function TaskCheck({ task, disabled }: { task: Task; disabled?: boolean }) {
  const closed = task.status !== 'open';
  return (
    <label className={`task-check-wrap priority-${task.priority}`} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        className="task-check"
        checked={closed}
        disabled={disabled || isPending(task)}
        aria-label={closed ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
        onChange={() => toggleTask(task)}
      />
    </label>
  );
}

function closeSheet(): void {
  useUi.getState().setSheetOpen(false);
}

/** The title as text, with clickable `[[links]]` (resolved from the list's file) and `#tags`. */
export function TaskTitle({ task, listPath }: { task: Pick<Task, 'title'>; listPath: string }) {
  const links = useTree().data?.links;
  return (
    <span className="task-title-text">
      {titleSegments(task.title).map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.text}</span>;
        if (s.kind === 'tag') {
          return (
            <a
              key={i}
              href="#"
              className="tag"
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                closeSheet();
                openTag(s.tag);
              }}
            >
              {s.text}
            </a>
          );
        }
        const resolved = links ? resolve(s.target, listPath, links) !== null : true;
        return (
          <a
            key={i}
            href="#"
            className={`internal-link${resolved ? '' : ' is-unresolved'}`}
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              closeSheet();
              void openLink(s.target, s.subpath, listPath);
            }}
          >
            {s.text}
          </a>
        );
      })}
    </span>
  );
}

export function DueLabel({ value, today, kind = 'due' }: { value: string; today: LocalDate; kind?: 'due' | 'start' }) {
  const tone = dateTone(value, today);
  return (
    <span className={`task-date tone-${tone}`} title={kind === 'start' ? `Starts ${value}` : `Due ${value}`}>
      {kind === 'start' && <span className="task-date-prefix">Starts </span>}
      {formatTaskDate(value, today)}
    </span>
  );
}

export function PriorityFlag({ priority }: { priority: Task['priority'] }) {
  if (priority === 0) return null;
  return (
    <span className={`task-priority priority-${priority}`} title={`${PRIORITY_NAMES[priority]} priority`}>
      <Flag size={13} aria-hidden />
      <span className="visually-hidden">{PRIORITY_NAMES[priority]} priority</span>
    </span>
  );
}

interface MetaProps {
  task: Task;
  today: LocalDate;
  /** The list chip (views over several lists). */
  list?: TaskList;
  /** Subtasks shown as "2/5". */
  subtasks?: { done: number; total: number };
  /** The parent's title, for a subtask shown out of its tree. */
  parentTitle?: string;
}

export function TaskMeta({ task, today, list, subtasks, parentTitle }: MetaProps) {
  const tags = taskTags({ tags: task.tags, title: '' });
  const items = [
    task.due && <DueLabel key="due" value={task.due} today={today} />,
    !task.due && task.start && <DueLabel key="start" value={task.start} today={today} kind="start" />,
    task.recurrence && (
      <span key="rec" className="task-meta-item" title={recurrenceText(task.recurrence.rrule)}>
        <Repeat size={13} aria-hidden />
        <span className="visually-hidden">Repeats {recurrenceText(task.recurrence.rrule)}</span>
      </span>
    ),
    task.priority > 0 && <PriorityFlag key="prio" priority={task.priority} />,
    subtasks && subtasks.total > 0 && (
      <span key="sub" className="task-meta-item" title="Subtasks done">
        <ListTree size={13} aria-hidden /> {subtasks.done}/{subtasks.total}
      </span>
    ),
    task.notes && (
      <span key="notes" className="task-meta-item" title="Has notes">
        <StickyNote size={13} aria-hidden />
        <span className="visually-hidden">Has notes</span>
      </span>
    ),
    task.links.length > 0 && (
      <span key="links" className="task-meta-item" title={task.links.join('\n')}>
        <Link2 size={13} aria-hidden /> {task.links.length}
      </span>
    ),
    ...tags.map((t) => (
      <span key={`tag-${t}`} className="task-tag">
        #{t}
      </span>
    )),
    parentTitle && (
      <span key="parent" className="task-meta-item task-meta-parent" title={`Subtask of ${parentTitle}`}>
        ↳ {parentTitle}
      </span>
    ),
    list && (
      <span key="list" className="task-meta-item task-meta-list">
        <ListDot list={list} /> {list.name}
      </span>
    ),
  ].filter(Boolean);
  if (items.length === 0) return null;
  return <span className="task-meta">{items}</span>;
}
