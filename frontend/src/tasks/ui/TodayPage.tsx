// `/x/tasks/today` (ROADMAP item 4, views): overdue tasks, tasks due today, and tasks with a start
// date of today or earlier, from every active list, in the server's order (API.md §20.2).
import { CalendarCheck, Plus } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { formatLongDate, useToday } from '../dates';
import { inToday, isOverdue, scheduleComparator } from '../model';
import { loadParser } from '../quickadd/loadParser';
import { todayParams, useTaskView } from '../queries';
import { FlatTaskRow, Loading, LoadError, TaskFab, TaskProblems, TasksNav } from './common';
import { useTaskData } from './useTaskData';
import { openQuickAdd } from './state';

export default function TodayPage() {
  usePageTitle('Today');
  const today = useToday();
  const query = useTaskView(todayParams(today));
  const data = useTaskData();
  const tasks = useMemo(() => [...data.tasks.values()].filter((t) => inToday(t, today, data.listMap)).sort(scheduleComparator(data.lists)), [data, today]);
  const overdue = tasks.filter((t) => isOverdue(t, today));
  const due = tasks.filter((t) => !isOverdue(t, today));
  const add = () => openQuickAdd({ due: today });

  useEffect(() => {
    void loadParser().catch(() => undefined);
  }, []);

  return (
    <div className="page tasks-page">
      <TasksNav />
      <header className="page-header">
        <div>
          <h1 className="page-title">Today</h1>
          <p className="tasks-subtitle">{formatLongDate(today)}</p>
        </div>
        <button type="button" className="button tasks-add-button" onClick={add}>
          <Plus size={14} aria-hidden /> Add task
        </button>
      </header>
      <TaskProblems problems={query.data?.problems ?? []} />
      {query.isPending ? (
        <Loading />
      ) : query.isError && tasks.length === 0 ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : tasks.length === 0 ? (
        <div className="empty-state">
          <CalendarCheck size={40} aria-hidden />
          <h2>Nothing for today</h2>
          <p>Tasks that are due or start today, or are overdue, appear here.</p>
        </div>
      ) : (
        <>
          {overdue.length > 0 && (
            <section className="tasks-group" aria-labelledby="tasks-overdue">
              <h2 id="tasks-overdue" className="tasks-group-title tone-overdue">
                Overdue <span className="tasks-count">{overdue.length}</span>
              </h2>
              <ul className="task-list">
                {overdue.map((t) => (
                  <FlatTaskRow key={t.id} task={t} today={today} data={data} />
                ))}
              </ul>
            </section>
          )}
          {due.length > 0 && (
            <section className="tasks-group" aria-labelledby="tasks-today">
              <h2 id="tasks-today" className="tasks-group-title">
                Today <span className="tasks-count">{due.length}</span>
              </h2>
              <ul className="task-list">
                {due.map((t) => (
                  <FlatTaskRow key={t.id} task={t} today={today} data={data} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <TaskFab onClick={add} />
    </div>
  );
}
