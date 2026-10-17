// `/x/tasks` (ROADMAP item 4): the index of all task lists, with their open and overdue counts,
// a Today shortcut, list actions (new, rename, reorder, archive, delete) and archived lists.
import { CalendarCheck, ChevronRight, Ellipsis, ListTodo, Plus } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ContextMenu } from '../../components/overlays/ContextMenu';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { navigateTo } from '../../features/navigation';
import type { TaskList } from '../../api/types';
import { useToday } from '../dates';
import { inOpenLists, inToday, isOverdue } from '../model';
import { listMenu, promptNewList } from './listActions';
import { loadParser } from '../quickadd/loadParser';
import { OPEN_TASKS, useTaskView } from '../queries';
import { Loading, LoadError, TaskFab, TaskProblems } from './common';
import { useTaskData } from './useTaskData';
import { ListDot } from './parts';
import { listRoute, openQuickAdd } from './state';

interface Menu {
  list: TaskList;
  x: number;
  y: number;
}

export default function ListsPage() {
  usePageTitle('Task lists');
  const today = useToday();
  const query = useTaskView(OPEN_TASKS);
  const data = useTaskData();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    void loadParser().catch(() => undefined);
  }, []);

  const counts = useMemo(() => {
    const out = new Map<string, { open: number; overdue: number }>();
    let todayCount = 0;
    for (const t of data.tasks.values()) {
      if (!inOpenLists(t, data.listMap)) continue;
      const c = out.get(t.listId) ?? { open: 0, overdue: 0 };
      c.open++;
      if (isOverdue(t, today)) c.overdue++;
      out.set(t.listId, c);
      if (inToday(t, today, data.listMap)) todayCount++;
    }
    return { byList: out, today: todayCount };
  }, [data, today]);

  const active = data.lists.filter((l) => !l.archived);
  const archived = data.lists.filter((l) => l.archived);
  const openMenu = (list: TaskList, e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ list, x: rect.left, y: rect.bottom + 4 });
  };

  const row = (list: TaskList) => {
    const c = counts.byList.get(list.id);
    return (
      <li key={list.id} className={`tasks-list-row${list.archived ? ' is-archived' : ''}`}>
        <button type="button" className="tasks-list-link" onClick={() => navigateTo(listRoute(list.id))}>
          <ListDot list={list} />
          <span className="tasks-list-name">{list.name}</span>
          {!list.writable && <span className="tasks-badge">read-only</span>}
          {c && c.overdue > 0 && (
            <span className="tasks-badge tone-overdue" title="Overdue">
              {c.overdue}
            </span>
          )}
          <span className="tasks-count" title="Open tasks">
            {c?.open ?? (list.archived ? '' : 0)}
          </span>
          <ChevronRight size={16} aria-hidden className="tasks-list-chevron" />
        </button>
        <button type="button" className="icon-button" aria-label={`More for ${list.name}`} title="More" aria-haspopup="menu" onClick={(e) => openMenu(list, e)}>
          <Ellipsis size={16} />
        </button>
      </li>
    );
  };

  const neighbours = (list: TaskList) => {
    const group = list.archived ? archived : active;
    const i = group.findIndex((l) => l.id === list.id);
    return { before: group[i - 1] ?? null, beforeBefore: group[i - 2] ?? null, after: group[i + 1] ?? null };
  };

  return (
    <div className="page tasks-page">
      <header className="page-header">
        <h1 className="page-title">Task lists</h1>
        <button type="button" className="button tasks-add-button" onClick={() => void promptNewList()}>
          <Plus size={14} aria-hidden /> New list
        </button>
      </header>
      <TaskProblems problems={query.data?.problems ?? []} />
      {query.isPending ? (
        <Loading />
      ) : query.isError && data.lists.length === 0 ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <ul className="tasks-lists">
            <li className="tasks-list-row">
              <button type="button" className="tasks-list-link" onClick={() => navigateTo('/x/tasks/today')}>
                <CalendarCheck size={16} aria-hidden className="tasks-list-icon" />
                <span className="tasks-list-name">Today</span>
                <span className="tasks-count">{counts.today}</span>
                <ChevronRight size={16} aria-hidden className="tasks-list-chevron" />
              </button>
            </li>
          </ul>
          {active.length === 0 ? (
            <div className="empty-state">
              <ListTodo size={40} aria-hidden />
              <h2>No lists yet</h2>
              <p>A task added without a list goes to the Inbox, which is created then.</p>
              <div className="empty-state-actions">
                <button type="button" className="button button-primary" onClick={() => openQuickAdd()}>
                  <Plus size={14} aria-hidden /> Add a task
                </button>
              </div>
            </div>
          ) : (
            <ul className="tasks-lists" aria-label="Lists">
              {active.map(row)}
            </ul>
          )}
          {archived.length > 0 && (
            <section className="tasks-group">
              <button type="button" className="link-button tasks-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
                {showArchived ? 'Hide' : 'Show'} archived lists ({archived.length})
              </button>
              {showArchived && (
                <ul className="tasks-lists" aria-label="Archived lists">
                  {archived.map(row)}
                </ul>
              )}
            </section>
          )}
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`${menu.list.name} actions`} items={listMenu(menu.list, neighbours(menu.list))} onClose={() => setMenu(null)} />}
      <TaskFab onClick={() => openQuickAdd()} />
    </div>
  );
}
