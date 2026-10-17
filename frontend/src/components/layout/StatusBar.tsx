// Desktop status bar (DESIGN §6.5): connection, save summary, history warning, the open note's
// word and character counts, and its backlink count.
import { CircleAlert, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useBacklinks } from '../../api/hooks';
import { countWords } from '../../features/format';
import { isNotePath, pathFromLocation } from '../../features/paths';
import { useUi, type SaveSummary } from '../../state/ui';
import { useDocumentSession, useSessionChangeCount } from '../../sync/useTextDocument';
import { isMarkdownViewPath } from '../../views/registry';
import { ConnectionIndicator } from '../ConnectionIndicator';
import { showPanel } from './showPanel';
import { useHistoryWarning } from './useHistoryWarning';

const SUMMARY: Record<SaveSummary, string> = {
  saved: 'All changes saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  offline: 'Offline: changes kept on this device',
  'storage-error': 'Server storage error',
  conflict: 'Conflict',
};

function Counts({ path }: { path: string }) {
  const session = useDocumentSession(path);
  const changes = useSessionChangeCount(session);
  const [counts, setCounts] = useState(() => countWords(session.getText()));
  useEffect(() => {
    const timer = setTimeout(() => setCounts(countWords(session.getText())), 300);
    return () => clearTimeout(timer);
  }, [changes, session]);
  return (
    <span className="status-item">
      {counts.words.toLocaleString()} {counts.words === 1 ? 'word' : 'words'} · {counts.chars.toLocaleString()} characters
    </span>
  );
}

function BacklinkCount({ path }: { path: string }) {
  const backlinks = useBacklinks(path, false).data;
  if (!backlinks) return null;
  const n = backlinks.linked.length;
  return (
    <button type="button" className="status-item status-button" title="Show backlinks" onClick={() => showPanel('right', 'backlinks')}>
      {n} {n === 1 ? 'backlink' : 'backlinks'}
    </button>
  );
}

export function StatusBar() {
  const summary = useUi((s) => s.saveSummary);
  const draftsFailing = useUi((s) => s.draftsFailing);
  const historyWarning = useHistoryWarning();
  const path = pathFromLocation(useLocation().pathname);
  const note = path !== null && isNotePath(path);
  return (
    <footer className="status-bar" aria-label="Status">
      <ConnectionIndicator />
      {historyWarning && (
        <span className="status-item tone-warning">
          <History size={13} aria-hidden /> {historyWarning}
        </span>
      )}
      {draftsFailing && (
        <span className="status-item tone-warning" title="The browser refused to store drafts (storage full or blocked)">
          <CircleAlert size={13} aria-hidden /> Unsaved changes are not protected on this device.
        </span>
      )}
      <span className={`status-item status-save status-${summary}`} aria-live="polite">
        {SUMMARY[summary]}
      </span>
      {note && <BacklinkCount key={`b:${path}`} path={path} />}
      {note && isMarkdownViewPath(path) && <Counts key={path} path={path} />}
    </footer>
  );
}
