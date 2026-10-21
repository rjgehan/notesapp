// The `tasks` file view (registerView, DESIGN §6.8): opening a `.tasks` file shows its list, as on
// the list's own page, with a Source button for the JSON (the text view, with its autosave and
// conflict banner). A link to one task, `[[Inbox.tasks#^<task id>]]` (what Convert checkbox to
// task leaves in a note), opens that task's details and points it out in the list. A file that is
// not a usable list (malformed, a copy, an archive) opens as its source, with the reason.
import { Code, ListTodo } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { ConflictBanner } from '../../components/ConflictBanner';
import { useDocumentSession } from '../../sync/useTextDocument';
import TextView from '../../views/TextView';
import type { FileViewProps } from '../../views/registry';
import { useTaskLists } from '../queries';
import { linkedTaskId } from '../taskLinks';
import { Loading } from './common';
import { ListScreen } from './ListScreen';
import { useTaskData } from './useTaskData';
import { openTaskDetail } from './state';

function Source({ path, entry, note, onList }: FileViewProps & { note?: string; onList?: () => void }) {
  const session = useDocumentSession(path);
  return (
    <div className="tasks-source">
      <ConflictBanner session={session} />
      {(note || onList) && (
        <div className="banner banner-info tasks-source-bar" role="note">
          <span>{note ?? 'The list’s file, as JSON. Changes made here are picked up by the task views.'}</span>
          {onList && (
            <button type="button" className="button button-small" onClick={onList}>
              <ListTodo size={14} aria-hidden /> Show as list
            </button>
          )}
        </div>
      )}
      <TextView path={path} entry={entry} mode="edit" />
    </div>
  );
}

export default function TaskFileView(props: FileViewProps) {
  const { path } = props;
  const lists = useTaskLists();
  const data = useTaskData();
  const { hash } = useLocation();
  const [params, setParams] = useSearchParams();
  const list = data.lists.find((l) => l.path === path);
  const taskId = linkedTaskId(hash);
  const showSource = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('view', 'source');
    else next.delete('view');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (taskId) openTaskDetail(taskId);
  }, [taskId]);

  if (params.get('view') === 'source') return <Source {...props} onList={list ? () => showSource(false) : undefined} />;
  if (list) {
    return (
      <ListScreen
        listId={list.id}
        asFile
        highlight={taskId}
        headerExtra={
          <button type="button" className="icon-button" aria-label="Show the file’s source" title="Source (JSON)" onClick={() => showSource(true)}>
            <Code size={17} />
          </button>
        }
      />
    );
  }
  if (lists.isPending) return <Loading />;
  const problem = (lists.data?.problems ?? []).find((p) => p.path === path && p.taskId === null);
  const note = problem
    ? `This file cannot be used as a task list: ${problem.reason}. Nothing in it was changed.`
    : 'This file is not a task list (an archive of completed tasks, or a file still being read). Archived tasks appear in Completed.';
  return <Source {...props} note={note} />;
}
