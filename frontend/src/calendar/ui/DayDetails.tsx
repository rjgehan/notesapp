// One day of the calendar (DESIGN §6.32): its daily note (open, or create from the template), the
// notes a property dates on it, its tasks with the check to complete them, a button that adds a
// task on that day, and the repeating tasks that come back on it. The selected day under the month
// grid, each day of the week view, and the day under the panel's grid.
import { FilePlus2, FileText, Plus, Repeat, StickyNote } from 'lucide-react';
import type { DatedNote, FileEntry, LocalDate, Task } from '../../api/types';
import { lastSegment } from '../../features/paths';
import { formatDay } from '../../tasks/dates';
import { FlatTaskRow } from '../../tasks/ui/common';
import { titleSegments } from '../../tasks/ui/display';
import { openQuickAdd } from '../../tasks/ui/state';
import type { TaskData } from '../../tasks/ui/useTaskData';
import { fullDayLabel } from './labels';

export interface DayDetailsProps {
  day: LocalDate;
  today: LocalDate;
  note: FileEntry | undefined;
  tasks: readonly Task[] | undefined;
  taskData: TaskData;
  onOpenNote(day: LocalDate): void;
  /** Opens a dated note. */
  onOpenPath(path: string): void;
  dated?: readonly DatedNote[];
  repeats?: readonly Task[];
  /** h2 on the page, h3 in the panel. */
  headingLevel?: 2 | 3;
  tasksLoading?: boolean;
  id?: string;
}

/** 'HH:mm' of a date-time value, else null. */
function timeOf(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2})/.exec(value)?.[1] ?? null;
}

function noteName(path: string): string {
  return lastSegment(path).replace(/\.md$/i, '');
}

export function DayDetails({ day, today, note, tasks, taskData, onOpenNote, onOpenPath, dated, repeats, headingLevel = 2, tasksLoading, id }: DayDetailsProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const rel = formatDay(day, today);
  const named = rel === 'Today' || rel === 'Tomorrow' || rel === 'Yesterday';
  const headingId = `cal-day-${day}`;
  return (
    <section id={id} className={`cal-day-details${day === today ? ' is-today' : ''}`} aria-labelledby={headingId}>
      <Heading id={headingId} className="cal-day-heading">
        {named && <span className="cal-day-rel">{rel}</span>}
        <span>{fullDayLabel(day)}</span>
      </Heading>
      <div className="cal-day-actions">
        <button
          type="button"
          className={`button cal-note-button${note ? ' has-note' : ''}`}
          onClick={() => onOpenNote(day)}
          title={note ? note.path : 'Create this day’s daily note from the daily-note template'}
        >
          {note ? <FileText size={15} aria-hidden /> : <FilePlus2 size={15} aria-hidden />}
          <span>{note ? note.basename : 'Create daily note'}</span>
        </button>
        <button type="button" className="button cal-add-task" aria-label={`Add task on ${fullDayLabel(day)}`} onClick={() => openQuickAdd({ due: day })}>
          <Plus size={15} aria-hidden />
          <span>Add task</span>
        </button>
      </div>
      {dated && dated.length > 0 && (
        <ul className="cal-dated" aria-label="Notes on this day">
          {dated.map((n) => (
            <li key={n.path}>
              <button type="button" className="cal-dated-link" title={`${n.path} (${n.property}: ${n.value})`} onClick={() => onOpenPath(n.path)}>
                <StickyNote size={14} aria-hidden />
                <span className="cal-dated-name">{noteName(n.path)}</span>
                {timeOf(n.value) && <span className="cal-dated-time muted">{timeOf(n.value)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {tasks && tasks.length > 0 ? (
        <ul className="task-list is-compact cal-day-tasks">
          {tasks.map((t) => (
            <FlatTaskRow key={t.id} task={t} today={today} data={taskData} />
          ))}
        </ul>
      ) : repeats && repeats.length > 0 && !tasksLoading ? null : (
        <p className="cal-day-empty muted">{tasksLoading ? 'Loading tasks…' : 'No tasks'}</p>
      )}
      {repeats && repeats.length > 0 && (
        <ul className="cal-repeats" aria-label="Repeating tasks due on this day">
          {repeats.map((t) => (
            <li key={t.id} className="cal-repeat" title="Comes back on this day when the current occurrence is done">
              <Repeat size={13} aria-hidden />
              <span>{titleSegments(t.title).map((s) => s.text).join('')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
