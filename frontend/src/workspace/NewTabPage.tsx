// What a new, empty tab shows (DESIGN §6.40): ways to fill it, and the recently opened files.
import { FileSearch, FilePlus, CalendarDays } from 'lucide-react';
import { useTree } from '../api/hooks';
import { getCommand, runCommand, useCommandsVersion } from '../features/commands';
import { openPath } from '../features/navigation';
import { displayName } from '../features/paths';
import { presentRecent, useRecentEntries } from '../features/recent';

export default function NewTabPage() {
  useCommandsVersion();
  const tree = useTree().data;
  const recent = presentRecent(useRecentEntries(), tree).slice(0, 8);
  const run = (id: string) => runCommand(id, { activePath: null });
  return (
    <div className="empty-state ws-new-tab">
      <h2>New tab</h2>
      <div className="empty-state-actions">
        {getCommand('app.quickSwitcher') && (
          <button type="button" className="button button-primary" onClick={() => run('app.quickSwitcher')}>
            <FileSearch size={16} aria-hidden /> Open a file
          </button>
        )}
        {getCommand('file.newNote') && (
          <button type="button" className="button" onClick={() => run('file.newNote')}>
            <FilePlus size={16} aria-hidden /> New note
          </button>
        )}
        {getCommand('daily.today') && (
          <button type="button" className="button" onClick={() => run('daily.today')}>
            <CalendarDays size={16} aria-hidden /> Today
          </button>
        )}
      </div>
      {recent.length > 0 && (
        <nav className="ws-new-tab-recent" aria-label="Recent files">
          <h3>Recent files</h3>
          {recent.map((r) => (
            <button key={r.path} type="button" className="link-button" title={r.path} onClick={() => openPath(r.path)}>
              {displayName(r.path)}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
