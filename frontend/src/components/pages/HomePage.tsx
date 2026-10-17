// `/` (DESIGN §6.4): today's daily note when `dailyNotes.openOnStartup` (once per page load);
// otherwise the last-opened note if it still exists, then Welcome.md, then an empty state.
import { NotebookPen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { useSettings, useTree } from '../../api/hooks';
import { getCommand, runCommand, useCommandsVersion } from '../../features/commands';
import { openTodaysDailyNote } from '../../features/daily';
import { noteRoute } from '../../features/paths';
import { lastOpenedPath } from '../../features/recent';

/** Once per page load. */
let startupHandled = false;

export function HomePage() {
  useCommandsVersion();
  const tree = useTree();
  const settings = useSettings();
  // React state, so that a startup daily note that could not be opened re-renders this page.
  const [handled, setHandled] = useState(startupHandled);
  const settingsPending = settings.isPending && !handled;

  useEffect(() => {
    if (settings.isPending || startupHandled) return;
    startupHandled = true;
    if (!settings.data?.settings.dailyNotes.openOnStartup) return;
    // On success the route changes; on failure (a toast says why) the usual home page shows.
    void openTodaysDailyNote().then((opened) => {
      if (!opened) setHandled(true);
    });
  }, [settings.isPending, settings.data]);

  if (tree.isPending || settingsPending) return <div className="view-loading" aria-busy="true" />;
  if (tree.isError) {
    return (
      <div className="empty-state">
        <h2>Cannot reach the server</h2>
        <p>The vault could not be loaded. It will retry automatically.</p>
      </div>
    );
  }
  // The effect opens today's note once the settings ask for it.
  if (!handled && settings.data?.settings.dailyNotes.openOnStartup) return <div className="view-loading" aria-busy="true" />;
  const last = lastOpenedPath();
  const target = (last && tree.data.byPath.has(last) ? last : null) ?? (tree.data.byPath.has('Welcome.md') ? 'Welcome.md' : null);
  if (target) return <Navigate to={noteRoute(target)} replace />;
  return (
    <div className="empty-state">
      <NotebookPen size={44} aria-hidden />
      <h2>No note is open</h2>
      <div className="empty-state-actions">
        {getCommand('file.newNote') && (
          <button type="button" className="button button-primary" onClick={() => runCommand('file.newNote', { activePath: null })}>
            New note
          </button>
        )}
        {getCommand('daily.today') && (
          <button type="button" className="button" onClick={() => runCommand('daily.today', { activePath: null })}>
            Today
          </button>
        )}
      </div>
    </div>
  );
}
