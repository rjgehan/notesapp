// "Tasks linking to this note" (registerPanel, right sidebar; ROADMAP item 4): the tasks whose
// title or notes link to the open note, or that list it among their related notes. The lists to
// look in come from the note's backlinks (a list file is a backlink source, API.md §20.9) and
// from the tasks already known here, so a note no task links to costs no task request.
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBacklinks, useTree } from '../../api/hooks';
import { isNotePath } from '../../features/paths';
import { useToday } from '../dates';
import { isClosed, linksTo, scheduleComparator } from '../model';
import { listParams, useTaskLists, useTaskViews } from '../queries';
import { FlatTaskRow } from './common';
import { useTaskData } from './useTaskData';
import { openQuickAdd } from './state';

export default function TasksPanel({ activePath }: { activePath: string | null }) {
  const today = useToday();
  const tree = useTree().data;
  const note = activePath !== null && isNotePath(activePath) && (tree?.byPath.has(activePath) ?? false) ? activePath : null;
  const backlinks = useBacklinks(note, false);
  useTaskLists();
  const data = useTaskData();
  const [showDone, setShowDone] = useState(false);

  // Lists whose file links to the note, plus lists of tasks known here that link to it.
  const listIds = useMemo(() => {
    const ids = new Set<string>();
    if (!note || !tree) return ids;
    const byPath = new Map(data.lists.map((l) => [l.path, l.id]));
    for (const g of backlinks.data?.linked ?? []) {
      const id = byPath.get(g.source);
      if (id) ids.add(id);
    }
    for (const t of data.tasks.values()) {
      const list = data.listMap.get(t.listId);
      if (list && !ids.has(list.id) && linksTo(t, note, list.path, tree.links)) ids.add(list.id);
    }
    return ids;
  }, [note, tree, backlinks.data, data]);

  const queries = useTaskViews([...listIds].sort().map(listParams));
  const loading = backlinks.isPending || queries.some((q) => q.isPending);

  const tasks = useMemo(() => {
    if (!note || !tree) return [];
    return [...data.tasks.values()]
      .filter((t) => {
        const list = data.listMap.get(t.listId);
        return list !== undefined && !t.archived && linksTo(t, note, list.path, tree.links);
      })
      .sort(scheduleComparator(data.lists));
  }, [note, tree, data]);

  if (!note) return <div className="panel-empty">Open a note to see the tasks that link to it.</div>;

  const open = tasks.filter((t) => !isClosed(t));
  const done = tasks.filter(isClosed);
  return (
    <div className="tasks-panel">
      <div className="panel-toolbar">
        <button type="button" className="button button-small" onClick={() => openQuickAdd({ links: [note] })}>
          <Plus size={14} aria-hidden /> Add task for this note
        </button>
      </div>
      {open.length === 0 && done.length === 0 ? (
        <div className="panel-empty">{loading ? 'Loading…' : 'No tasks link to this note.'}</div>
      ) : (
        <>
          <ul className="task-list is-compact">
            {open.map((t) => (
              <FlatTaskRow key={t.id} task={t} today={today} data={data} />
            ))}
          </ul>
          {done.length > 0 && (
            <>
              <button type="button" className="link-button tasks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                {showDone ? 'Hide' : 'Show'} completed ({done.length})
              </button>
              {showDone && (
                <ul className="task-list is-compact">
                  {done.map((t) => (
                    <FlatTaskRow key={t.id} task={t} today={today} data={data} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
