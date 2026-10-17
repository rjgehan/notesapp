// `/x/tasks/completed` (ROADMAP item 4, views): the log of finished tasks, newest first, grouped
// by the day they were completed (API.md §20.2 `view=completed`, archived tasks included), page by
// page. A task can be reopened from here; the log can be narrowed to one list.
import { CircleCheckBig } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Task } from '../../api/types';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { dayjs } from '../../features/dates';
import { addDays, formatTime, localToday, useToday } from '../dates';
import { compareCompleted, isClosed, matchesFilter } from '../model';
import { isPending } from '../mutations';
import { useCompletedTasks, useTaskLists } from '../queries';
import { Loading, LoadError, TaskProblems, TasksNav } from './common';
import { useTaskData } from './useTaskData';
import { ListDot, TaskCheck, TaskTitle } from './parts';
import { openTaskDetail } from './state';

const UNKNOWN = 'unknown';
const thisYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const otherYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

/** 'Today', 'Yesterday', 'Thursday, October 15', or with the year when it is not this one. */
function dayTitle(day: string, today: string): string {
  if (day === UNKNOWN) return 'Date unknown';
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  return (day.slice(0, 4) === today.slice(0, 4) ? thisYear : otherYear).format(new Date(y, m - 1, d));
}

/** The local day a task was completed on ('unknown' for a hand-written task without a time). */
function completionDay(task: Task): string {
  return task.completedAt ? localToday(new Date(task.completedAt)) : UNKNOWN;
}

function CompletedRow({ task, data }: { task: Task; data: ReturnType<typeof useTaskData> }) {
  const list = data.listMap.get(task.listId);
  const open = () => !isPending(task) && openTaskDetail(task.id);
  return (
    <li className="task-row is-closed" data-task-id={task.id}>
      <TaskCheck task={task} disabled={list?.writable === false} />
      <div className="task-row-body" onClick={open}>
        <span className="task-title">
          <TaskTitle task={task} listPath={list?.path ?? ''} />
        </span>
        <span className="task-meta">
          {task.status === 'cancelled' && <span className="tasks-badge">cancelled</span>}
          {task.completedAt && <span className="task-meta-item">{formatTime(dayjs(task.completedAt).format('HH:mm'))}</span>}
          {task.archived && <span className="task-meta-item">archived</span>}
          {list && (
            <span className="task-meta-item task-meta-list">
              <ListDot list={list} /> {list.name}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

export default function CompletedPage() {
  usePageTitle('Completed');
  const today = useToday();
  const [listId, setListId] = useState('');
  const filter = useMemo(() => (listId ? { list: listId } : {}), [listId]);
  const query = useCompletedTasks(filter);
  const lists = useTaskLists();
  const data = useTaskData();
  const pages = query.data?.pages ?? [];
  const last = pages.at(-1);
  // Tasks completed after the last page's floor are all loaded; with no floor, everything is.
  const floor = last?.floor ? Date.parse(last.floor) : null;

  const groups = useMemo(() => {
    const tasks = [...data.tasks.values()]
      .filter((t) => isClosed(t) && matchesFilter(t, filter) && data.listMap.has(t.listId))
      .filter((t) => (floor === null ? true : t.completedAt !== null && Date.parse(t.completedAt) >= floor))
      .sort(compareCompleted);
    const out: Array<{ day: string; tasks: Task[] }> = [];
    for (const t of tasks) {
      const day = completionDay(t);
      if (out.at(-1)?.day === day) out.at(-1)!.tasks.push(t);
      else out.push({ day, tasks: [t] });
    }
    return out;
  }, [data, filter, floor]);

  const total = pages[0]?.total ?? 0;
  const problems = pages[0]?.problems ?? [];

  return (
    <div className="page tasks-page">
      <TasksNav />
      <header className="page-header">
        <div>
          <h1 className="page-title">Completed</h1>
          <p className="tasks-subtitle">{query.isPending ? '' : `${total} ${total === 1 ? 'task' : 'tasks'} completed`}</p>
        </div>
        <select className="select tasks-filter-select" aria-label="List" value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">All lists</option>
          {(lists.data ? data.lists : []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.archived ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </header>
      <TaskProblems problems={problems} />
      {query.isPending ? (
        <Loading />
      ) : query.isError && groups.length === 0 ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <CircleCheckBig size={40} aria-hidden />
          <h2>Nothing completed yet</h2>
          <p>Tasks you finish appear here, newest first.</p>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.day} className="tasks-group" aria-labelledby={`tasks-done-${g.day}`}>
              <h2 id={`tasks-done-${g.day}`} className="tasks-group-title">
                {dayTitle(g.day, today)} <span className="tasks-count">{g.tasks.length}</span>
              </h2>
              <ul className="task-list">
                {g.tasks.map((t) => (
                  <CompletedRow key={t.id} task={t} data={data} />
                ))}
              </ul>
            </section>
          ))}
          {query.hasNextPage && (
            <div className="tasks-more">
              <button type="button" className="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? 'Loading…' : 'Show older'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
