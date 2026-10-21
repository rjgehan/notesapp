// `/x/tasks/upcoming` (ROADMAP item 4, views): the open tasks of the next 14 days, today included,
// grouped by day in the server's order (API.md §20.2 `view=upcoming`), with a week strip on top
// that shows how busy each day is and jumps to it. Each day can take a new task.
import { CalendarRange, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../api/types';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { addDays, datePart, formatDay, formatLongDate, useToday } from '../dates';
import { inUpcoming, scheduleComparator, scheduled } from '../model';
import { loadParser } from '../quickadd/loadParser';
import { UPCOMING_DAYS, upcomingParams, useTaskView } from '../queries';
import { FlatTaskRow, Loading, LoadError, TaskFab, TaskProblems, TasksNav } from './common';
import { useTaskData } from './useTaskData';
import { openQuickAdd } from './state';

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

function localDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const dayId = (date: string) => `tasks-day-${date}`;

export default function UpcomingPage() {
  usePageTitle('Upcoming');
  const today = useToday();
  const query = useTaskView(upcomingParams(today));
  const data = useTaskData();
  const [week, setWeek] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: UPCOMING_DAYS }, (_, i) => addDays(today, i)), [today]);

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    const tasks = [...data.tasks.values()].filter((t) => inUpcoming(t, today, UPCOMING_DAYS, data.listMap)).sort(scheduleComparator(data.lists));
    for (const t of tasks) {
      const day = datePart(scheduled(t)!);
      const list = map.get(day);
      if (list) list.push(t);
      else map.set(day, [t]);
    }
    return map;
  }, [data, today]);

  useEffect(() => {
    void loadParser().catch(() => undefined);
  }, []);

  const jump = (day: string) => {
    setSelected(day);
    document.getElementById(dayId(day))?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const strip = days.slice(week * 7, week * 7 + 7);
  const total = [...byDay.values()].reduce((n, l) => n + l.length, 0);

  return (
    <div className="page tasks-page tasks-upcoming-page">
      <TasksNav />
      <header className="page-header">
        <div>
          <h1 className="page-title">Upcoming</h1>
          <p className="tasks-subtitle">
            The next {UPCOMING_DAYS} days{total > 0 ? ` · ${total} ${total === 1 ? 'task' : 'tasks'}` : ''}
          </p>
        </div>
        <button type="button" className="button tasks-add-button" onClick={() => openQuickAdd({ due: selected ?? today })}>
          <Plus size={14} aria-hidden /> Add task
        </button>
      </header>
      <div className="tasks-week" role="group" aria-label={week === 0 ? 'This week' : 'Next week'}>
        <button type="button" className="icon-button tasks-week-turn" aria-label="Previous week" disabled={week === 0} onClick={() => setWeek(0)}>
          <ChevronLeft size={16} />
        </button>
        <ol className="tasks-week-days">
          {strip.map((day) => {
            const count = byDay.get(day)?.length ?? 0;
            const d = localDate(day);
            return (
              <li key={day}>
                <button
                  type="button"
                  className={`tasks-week-day${day === today ? ' is-today' : ''}${day === selected ? ' is-selected' : ''}`}
                  aria-label={`${formatDay(day, today)}, ${formatLongDate(day)}: ${count === 0 ? 'no tasks' : count === 1 ? '1 task' : `${count} tasks`}`}
                  title={weekdayLong.format(d)}
                  onClick={() => jump(day)}
                >
                  <span className="tasks-week-name" aria-hidden>
                    {weekday.format(d)}
                  </span>
                  <span className="tasks-week-date" aria-hidden>
                    {d.getDate()}
                  </span>
                  <span className={`tasks-week-load${count > 0 ? ' has-tasks' : ''}`} aria-hidden>
                    {count > 0 ? count : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="icon-button tasks-week-turn" aria-label="Next week" disabled={week === 1} onClick={() => setWeek(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <TaskProblems problems={query.data?.problems ?? []} />
      {query.isPending ? (
        <Loading />
      ) : query.isError && byDay.size === 0 ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {total === 0 && (
            <div className="empty-state">
              <CalendarRange size={40} aria-hidden />
              <h2>Nothing scheduled</h2>
              <p>Tasks due or starting in the next {UPCOMING_DAYS} days appear here, day by day.</p>
            </div>
          )}
          {days.map((day) => {
            const tasks = byDay.get(day) ?? [];
            const label = formatDay(day, today);
            const long = formatLongDate(day);
            return (
              <section key={day} id={dayId(day)} className={`tasks-group tasks-day${tasks.length === 0 ? ' is-empty' : ''}`} aria-labelledby={`${dayId(day)}-title`}>
                <h2 id={`${dayId(day)}-title`} className={`tasks-group-title${day === today ? ' tone-today' : ''}`}>
                  <span>{day === today || day === addDays(today, 1) ? `${label} · ${long}` : long}</span>
                  <span className="tasks-count">{tasks.length > 0 ? tasks.length : ''}</span>
                  <button type="button" className="icon-button tasks-day-add" aria-label={`Add task on ${long}`} title="Add task" onClick={() => openQuickAdd({ due: day })}>
                    <Plus size={15} />
                  </button>
                </h2>
                {tasks.length > 0 && (
                  <ul className="task-list">
                    {tasks.map((t) => (
                      <FlatTaskRow key={t.id} task={t} today={today} data={data} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </>
      )}
      <TaskFab onClick={() => openQuickAdd({ due: selected ?? today })} />
    </div>
  );
}
