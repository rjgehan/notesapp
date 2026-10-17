// History panel (DESIGN §6.11), a lazy chunk: the file's commits (following renames), the pending
// batch with "Commit now", the version view with diff, full text and restore, and why a file over
// the large-file threshold has no new versions (ROADMAP item 23).
import { GitCommitHorizontal, HardDrive, History } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { useHistory } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { HistoryEntry, HistoryExclusion } from '../../api/types';
import { formatBytes, formatDateTime, formatRelative } from '../../features/format';
import { formatLimit } from '../../features/largeFiles';
import { displayName } from '../../features/paths';
import { toastError } from '../../features/errors';

const HistoryVersion = lazy(() => import('./HistoryVersion'));

function ChangeBadge({ entry }: { entry: HistoryEntry }) {
  if (entry.change === 'renamed') {
    return (
      <span className="history-badge is-renamed" title={entry.renamedFrom ?? undefined}>
        renamed{entry.renamedFrom ? ` from ${displayName(entry.renamedFrom)}` : ''}
      </span>
    );
  }
  return <span className={`history-badge is-${entry.change}`}>{entry.change}</span>;
}

function PendingRow() {
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    setBusy(true);
    try {
      await api.commitHistory();
      void queryClient.invalidateQueries({ queryKey: queryKeys.historyAll() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status() });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="history-row is-pending">
      <span className="history-row-main">
        <span className="history-message">Uncommitted changes</span>
        <span className="history-meta">committing within 30 s</span>
      </span>
      <button type="button" className="button button-small" disabled={busy} onClick={() => void commit()}>
        <GitCommitHorizontal size={13} aria-hidden /> Commit now
      </button>
    </li>
  );
}

/** Why a file over the large-file threshold has no new versions in history (DESIGN §6.11). */
function ExcludedNote({ excluded }: { excluded: HistoryExclusion }) {
  return (
    <div className="history-excluded" role="note">
      <HardDrive size={16} aria-hidden />
      <p>
        This file is {formatBytes(excluded.size)}, larger than the {formatLimit(excluded.limitBytes)} limit for history, so its versions are not
        kept in git. The file itself stays in the vault and in backups, and replacing it moves the old one to the trash.
      </p>
    </div>
  );
}

function HistoryList({ path }: { path: string }) {
  const history = useHistory(path);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  if (history.isPending) return <div className="panel-empty">Loading…</div>;
  if (history.isError) return <div className="panel-empty">{errorMessage(history.error)}</div>;
  const pages = history.data.pages;
  const entries = pages.flatMap((p) => p.entries);
  const pending = pages[0]?.pending ?? false;
  const excluded = pages[0]?.excluded ?? null;
  return (
    <div className="history">
      {excluded && <ExcludedNote excluded={excluded} />}
      {entries.length === 0 && !pending ? (
        !excluded && (
          <div className="panel-empty">
            <History size={28} aria-hidden />
            <p>No history for this file yet.</p>
          </div>
        )
      ) : (
        <ul className="history-list" aria-label={`History of ${displayName(path)}`}>
          {pending && <PendingRow />}
          {entries.map((e) => (
            <li key={`${e.commitId}:${e.path}`} className="history-row">
              <button type="button" className="history-row-main" onClick={() => setSelected(e)}>
                <span className="history-message">{e.message}</span>
                <span className="history-meta">
                  <time dateTime={e.time} title={formatDateTime(e.time)}>
                    {formatRelative(e.time)}
                  </time>
                  {' · '}
                  {e.authorName}
                </span>
              </button>
              <ChangeBadge entry={e} />
            </li>
          ))}
        </ul>
      )}
      {history.hasNextPage && (
        <button type="button" className="button button-small history-more" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
      {selected && (
        <Suspense fallback={null}>
          <HistoryVersion entry={selected} currentPath={path} onClose={() => setSelected(null)} />
        </Suspense>
      )}
    </div>
  );
}

export default function HistoryPanel({ activePath }: { activePath: string | null }) {
  if (!activePath) return <div className="panel-empty">Open a file to see its history.</div>;
  return <HistoryList key={activePath} path={activePath} />;
}
