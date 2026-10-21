// `/x/tasks/filter` (ROADMAP item 4, views): tasks by tag, priority and list, open or all, from
// `view=list` with the server's filters (API.md §20.2). The filter lives in the address
// (`?tag=home&priority=2,3&list=…&status=all`), so a filter can be bookmarked or linked from a note.
// Results are grouped by list, each in schedule order (date, then priority).
import { Flag, ListFilter, X } from 'lucide-react';
import { useEffect, useId, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useTags } from '../../api/hooks';
import type { Task, TaskPriority } from '../../api/types';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { useToday } from '../dates';
import { filterFromParams, inListView, matchesFilter, PRIORITY_NAMES, prioritiesOf, scheduleComparator, statusesOf, taskTags, type TaskFilter } from '../model';
import { loadParser } from '../quickadd/loadParser';
import { useTaskView } from '../queries';
import { FlatTaskRow, Loading, LoadError, TaskProblems, TasksNav } from './common';
import { useTaskData } from './useTaskData';
import { ListDot } from './parts';

export default function FilterPage() {
  usePageTitle('Filter');
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  const query = useTaskView({ view: 'list', ...filter });
  const data = useTaskData();
  const vaultTags = useTags().data?.tags;
  const tagListId = useId();
  const priorities = prioritiesOf(filter.priority) ?? new Set<number>();

  useEffect(() => {
    void loadParser().catch(() => undefined);
  }, []);

  const set = (patch: Partial<Record<keyof TaskFilter, string | undefined>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const groups = useMemo(() => {
    const statuses = statusesOf(filter.status, 'list');
    const match = [...data.tasks.values()].filter((t) => statuses.has(t.status) && inListView(t, data.listMap, filter.list) && matchesFilter(t, filter));
    const order = scheduleComparator(data.lists);
    return data.lists
      .map((list) => ({ list, tasks: match.filter((t) => t.listId === list.id).sort(order) }))
      .filter((g) => g.tasks.length > 0);
  }, [data, filter]);

  const suggestions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of data.tasks.values()) for (const tag of taskTags(t)) seen.set(tag.toLowerCase(), tag);
    for (const t of vaultTags ?? []) if (!seen.has(t.tag.toLowerCase())) seen.set(t.tag.toLowerCase(), t.tag);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [data, vaultTags]);

  const count = groups.reduce((n, g) => n + g.tasks.length, 0);
  const any = Object.keys(filter).length > 0;
  const togglePriority = (p: TaskPriority) => {
    const next = new Set(priorities);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    set({ priority: [...next].sort().join(',') || undefined });
  };

  return (
    <div className="page tasks-page">
      <TasksNav />
      <header className="page-header">
        <div>
          <h1 className="page-title">Filter</h1>
          <p className="tasks-subtitle">{query.isPending && groups.length === 0 ? '' : `${count} ${filter.status === 'all' ? '' : 'open '}${count === 1 ? 'task' : 'tasks'}`}</p>
        </div>
        {any && (
          <button type="button" className="button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            <X size={14} aria-hidden /> Clear
          </button>
        )}
      </header>
      <div className="tasks-filters" role="group" aria-label="Filters">
        <label className="tasks-filter">
          <span className="tasks-filter-label">List</span>
          <select className="select" value={filter.list ?? ''} onChange={(e) => set({ list: e.target.value || undefined })}>
            <option value="">All active lists</option>
            {data.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="tasks-filter">
          <span className="tasks-filter-label">Tag</span>
          <input
            className="text-input"
            list={tagListId}
            placeholder="#tag"
            defaultValue={filter.tag ? `#${filter.tag}` : ''}
            key={filter.tag ?? ''}
            onBlur={(e) => set({ tag: e.target.value.trim().replace(/^#/, '') || undefined })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') set({ tag: e.currentTarget.value.trim().replace(/^#/, '') || undefined });
            }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          <datalist id={tagListId}>
            {suggestions.map((t) => (
              <option key={t} value={`#${t}`} />
            ))}
          </datalist>
        </label>
        <div className="tasks-filter" role="group" aria-label="Priority">
          <span className="tasks-filter-label" aria-hidden>
            Priority
          </span>
          <div className="segmented tasks-filter-priority">
            {([3, 2, 1, 0] as TaskPriority[]).map((p) => (
              <button key={p} type="button" aria-pressed={priorities.has(p)} className={`${priorities.has(p) ? 'is-active' : ''} priority-${p}`} onClick={() => togglePriority(p)}>
                {p > 0 && <Flag size={13} aria-hidden />} {PRIORITY_NAMES[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="tasks-filter" role="radiogroup" aria-label="Status">
          <span className="tasks-filter-label" aria-hidden>
            Show
          </span>
          <div className="segmented">
            <button type="button" role="radio" aria-checked={filter.status !== 'all'} className={filter.status !== 'all' ? 'is-active' : ''} onClick={() => set({ status: undefined })}>
              Open
            </button>
            <button type="button" role="radio" aria-checked={filter.status === 'all'} className={filter.status === 'all' ? 'is-active' : ''} onClick={() => set({ status: 'all' })}>
              All
            </button>
          </div>
        </div>
      </div>
      <TaskProblems problems={query.data?.problems ?? []} />
      {query.isPending && groups.length === 0 ? (
        <Loading />
      ) : query.isError && groups.length === 0 ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <ListFilter size={40} aria-hidden />
          <h2>No tasks match</h2>
          <p>{any ? 'Try another tag, priority or list.' : 'Open tasks of every active list appear here; narrow them by tag, priority or list.'}</p>
        </div>
      ) : (
        groups.map(({ list, tasks }) => (
          <section key={list.id} className="tasks-group" aria-labelledby={`tasks-filter-${list.id}`}>
            <h2 id={`tasks-filter-${list.id}`} className="tasks-group-title">
              <ListDot list={list} /> {list.name} <span className="tasks-count">{tasks.length}</span>
            </h2>
            <ul className="task-list">
              {tasks.map((t: Task) => (
                <FlatTaskRow key={t.id} task={t} today={today} data={data} showList={false} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
