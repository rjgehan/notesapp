// `/x/history`: the vault-wide history (ROADMAP item 28, API.md §14.6–14.8), a registered page.
// Timeline: every commit with its files, filtered by path, author and period. Changes: what
// changed over a period ("this week"), each file diffed between the start and the end. Deleted:
// files deleted long ago, previewed and restored straight from git, even after the trash was
// emptied.
import { ArchiveRestore, Eye, FileDiff, GitCommitHorizontal, History, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { useDeletedFiles, useHistoryChanges, useHistoryContent, useHistoryLog, useTree } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { DeletedFile, HistoryEntry, TimelineFile } from '../../api/types';
import { toLf } from '../../features/eol';
import { toastError } from '../../features/errors';
import { kindOfPath } from '../../features/fileKinds';
import { formatDateTime, formatRelative } from '../../features/format';
import { groupByDay, historyEntryOf, PERIODS, periodStart, type Period } from '../../features/historyPeriods';
import { navigateTo } from '../../features/navigation';
import { displayName, folderOf, isNotePath, noteRoute } from '../../features/paths';
import { confirmAction } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { applyHistoryRestoreResult } from '../../sync/applyEvents';
import { syncTarget } from '../../sync/liveSync';
import { Modal } from '../overlays/Modal';
import HistoryVersion, { DiffPane } from '../panels/HistoryVersion';
import { usePageTitle } from './usePageTitle';

type Tab = 'timeline' | 'changes' | 'deleted';

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function ChangeBadge({ file }: { file: Pick<TimelineFile, 'change' | 'renamedFrom'> }) {
  return (
    <span className={`history-badge is-${file.change}`} title={file.renamedFrom ? `renamed from ${file.renamedFrom}` : undefined}>
      {file.change === 'renamed' && file.renamedFrom ? `renamed from ${displayName(file.renamedFrom)}` : file.change}
    </span>
  );
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function Loading() {
  return (
    <div className="view-loading" aria-busy="true">
      <div className="skeleton-line" />
    </div>
  );
}

function Failure({ error }: { error: unknown }) {
  return (
    <div className="error-panel" role="alert">
      <p className="error-panel-title">The history could not be loaded.</p>
      <p className="error-panel-detail">{errorMessage(error)}</p>
    </div>
  );
}

function PeriodSelect({ value, onChange, label }: { value: Period; onChange(p: Period): void; label: string }) {
  return (
    <select className="timeline-select" value={value} onChange={(e) => onChange(e.target.value as Period)} aria-label={label}>
      {PERIODS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

/** A file in a list: its name (opens it when it exists now), folder and change. */
function FileLine({ file, onShow, exists }: { file: TimelineFile; onShow(): void; exists: boolean }) {
  const folder = folderOf(file.path);
  return (
    <li className="timeline-file">
      <button type="button" className="timeline-file-main" onClick={onShow} title={`Show this version of ${file.path}`}>
        <span className="timeline-file-name">{displayName(file.path)}</span>
        {folder && <span className="timeline-file-folder">{folder}</span>}
      </button>
      <ChangeBadge file={file} />
      {exists && (
        <button type="button" className="link-button timeline-open" onClick={() => navigateTo(noteRoute(file.path))}>
          Open
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- timeline

function Timeline({ onVersion }: { onVersion(entry: HistoryEntry): void }) {
  const [path, setPath] = useState('');
  const [author, setAuthor] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const filter = { path: useDebounced(path.trim()) || undefined, author: useDebounced(author.trim()) || undefined, since: periodStart(period) };
  const log = useHistoryLog(filter);
  const tree = useTree().data;
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-filters">
        <input className="text-input" placeholder="Folder or file path" aria-label="Filter by path" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
        <input className="text-input" placeholder="Author" aria-label="Filter by author" value={author} onChange={(e) => setAuthor(e.target.value)} spellCheck={false} />
        <PeriodSelect value={period} onChange={setPeriod} label="Period" />
      </div>
      {log.isPending ? (
        <Loading />
      ) : log.isError ? (
        <Failure error={log.error} />
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <History size={40} aria-hidden />
          <h2>No commits</h2>
          <p>Nothing in history matches these filters.</p>
        </div>
      ) : (
        <>
          {groupByDay(entries).map((group) => (
            <div key={group.day} className="timeline-day">
              <h2 className="timeline-day-title">{dayLabel(group.day)}</h2>
              <ul className="timeline-commits">
                {group.items.map((c) => (
                  <li key={c.commitId} className="timeline-commit">
                    <div className="timeline-commit-head">
                      <GitCommitHorizontal size={14} aria-hidden />
                      <span className="timeline-message">{c.message}</span>
                      <span className="timeline-meta">
                        <time dateTime={c.time} title={formatDateTime(c.time)}>
                          {new Date(c.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </time>{' '}
                        · {c.authorName} · <code>{c.shortId}</code>
                      </span>
                    </div>
                    {c.files.length > 0 && (
                      <ul className="timeline-files">
                        {c.files.map((f) => (
                          <FileLine key={f.path} file={f} exists={!!tree?.byPath.has(f.path)} onShow={() => onVersion(historyEntryOf(c, f))} />
                        ))}
                        {c.filesTotal > c.files.length && <li className="timeline-more">and {c.filesTotal - c.files.length} more</li>}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {log.hasNextPage && (
            <button type="button" className="button button-small history-more" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- changes over a period

interface Comparison {
  file: TimelineFile;
  from: string | null;
  to: string | null;
  label: string;
}

/** A file diffed between two commits; an added file starts empty, a deleted one ends empty. */
function CompareVersions({ comparison, onClose }: { comparison: Comparison; onClose(): void }) {
  const { file, from, to } = comparison;
  const kind = kindOfPath(file.path);
  const textual = kind === 'note' || kind === 'text';
  const fromPath = file.renamedFrom ?? file.path;
  const before = useHistoryContent(textual && file.change !== 'added' ? from : null, fromPath);
  const after = useHistoryContent(textual && file.change !== 'deleted' ? to : null, file.path);
  const text = (q: typeof before, used: boolean): string | null => (!used ? '' : q.data && q.data.content !== null ? toLf(q.data.content) : null);
  const old = text(before, file.change !== 'added' && from !== null);
  const now = text(after, file.change !== 'deleted' && to !== null);
  const failed = before.isError ? before.error : after.isError ? after.error : null;
  let body: ReactNode;
  if (!textual) {
    body = (
      <div className="panel-empty">
        <p>This file cannot be compared as text.</p>
        {to && file.change !== 'deleted' && (
          <a className="link-button" href={api.historyRawUrl(file.path, to)} download={displayName(file.path)}>
            Download the newer version
          </a>
        )}
      </div>
    );
  } else if (failed) {
    body = <div className="panel-empty">{errorMessage(failed)}</div>;
  } else if (old === null || now === null) {
    body = <Loading />;
  } else {
    body = <DiffPane historical={old} current={now} markdown={isNotePath(file.path)} sameLabel="No change in content" />;
  }
  return (
    <Modal label={`Changes to ${displayName(file.path)}`} onClose={onClose} variant="sheet" className="history-version">
      <header className="compare-header">
        <div>
          <h2 className="dialog-title">{displayName(file.path)}</h2>
          <p className="compare-legend">
            {comparison.label} · <ChangeBadge file={file} />
          </p>
        </div>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="history-version-body">{body}</div>
    </Modal>
  );
}

function Changes() {
  const [period, setPeriod] = useState<Period>('week');
  const [path, setPath] = useState('');
  const filter = { since: periodStart(period), path: useDebounced(path.trim()) || undefined };
  const changes = useHistoryChanges(filter);
  const tree = useTree().data;
  const [comparing, setComparing] = useState<Comparison | null>(null);
  const label = PERIODS.find((p) => p.id === period)?.label ?? '';
  const data = changes.data;
  return (
    <section className="timeline" aria-label="Changes">
      <div className="timeline-filters">
        <PeriodSelect value={period} onChange={setPeriod} label="Period" />
        <input className="text-input" placeholder="Folder or file path" aria-label="Filter by path" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
      </div>
      {changes.isPending ? (
        <Loading />
      ) : changes.isError ? (
        <Failure error={changes.error} />
      ) : !data || data.files.length === 0 ? (
        <div className="empty-state">
          <FileDiff size={40} aria-hidden />
          <h2>Nothing changed</h2>
          <p>{data && data.commits > 0 ? 'Files changed and changed back, or only settings changed.' : `No commits ${label === 'All time' ? 'yet' : 'in this period'}.`}</p>
        </div>
      ) : (
        <>
          <p className="timeline-summary">
            {label}: {data.files.length}
            {data.truncated ? '+' : ''} {data.files.length === 1 ? 'file' : 'files'} changed in {data.commits} {data.commits === 1 ? 'commit' : 'commits'}
            {data.authors.length > 0 && <> by {data.authors.join(', ')}</>}.
          </p>
          <ul className="timeline-files is-flat">
            {data.files.map((f) => (
              <FileLine
                key={f.path}
                file={f}
                exists={!!tree?.byPath.has(f.path)}
                onShow={() => setComparing({ file: f, from: data.fromCommitId, to: data.toCommitId, label: `${label}: start → end` })}
              />
            ))}
          </ul>
        </>
      )}
      {comparing && <CompareVersions comparison={comparing} onClose={() => setComparing(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------- deleted files

function deletedEntry(d: DeletedFile): HistoryEntry {
  return {
    commitId: d.commitId,
    shortId: d.shortId,
    parentCommitId: d.parentCommitId,
    path: d.path,
    time: d.deletedAt,
    authorName: d.authorName,
    authorLogin: d.authorLogin,
    message: d.message,
    change: 'deleted',
    renamedFrom: null,
  };
}

function DeletedRow({ file, onPreview }: { file: DeletedFile; onPreview(): void }) {
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    const ok = await confirmAction({
      title: 'Restore this file?',
      message: `“${file.path}” will be brought back with its last version, from before ${formatDateTime(file.deletedAt)}.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await api.restoreHistory({ path: file.path, commit: file.parentCommitId, sourcePath: file.path, baseVersion: null });
      applyHistoryRestoreResult(syncTarget, result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultHistoryAll() });
      toast(`Restored ${displayName(file.path)}`, { action: { label: 'Open', run: () => navigateTo(noteRoute(result.file.path)) } });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const folder = folderOf(file.path);
  return (
    <li className="trash-row">
      <span className="trash-main">
        <span className="trash-name">{displayName(file.path)}</span>
        <span className="trash-meta">
          {folder && <span>{folder} · </span>}
          deleted{' '}
          <time dateTime={file.deletedAt} title={formatDateTime(file.deletedAt)}>
            {formatRelative(file.deletedAt)}
          </time>{' '}
          by {file.authorName}
        </span>
      </span>
      <span className="trash-actions">
        <button type="button" className="icon-button" aria-label={`Preview ${displayName(file.path)}`} title="Preview the last version" onClick={onPreview}>
          <Eye size={16} />
        </button>
        <button type="button" className="button button-small" disabled={busy} onClick={() => void restore()}>
          <RotateCcw size={14} aria-hidden /> Restore
        </button>
      </span>
    </li>
  );
}

function Deleted({ onVersion }: { onVersion(entry: HistoryEntry): void }) {
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim());
  const deleted = useDeletedFiles(query);
  const entries = deleted.data?.pages.flatMap((p) => p.entries) ?? [];
  const total = deleted.data?.pages[0]?.total ?? 0;
  return (
    <section className="timeline" aria-label="Deleted files">
      <div className="timeline-filters">
        <div className="search-field timeline-search">
          <Search size={15} className="search-field-icon" aria-hidden />
          <input className="text-input search-input" placeholder="Find a deleted file…" aria-label="Find a deleted file" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <p className="timeline-summary">Files deleted at some point that do not exist now, newest deletion first. They can be restored from history even after the trash was emptied.</p>
      {deleted.isPending ? (
        <Loading />
      ) : deleted.isError ? (
        <Failure error={deleted.error} />
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <ArchiveRestore size={40} aria-hidden />
          <h2>No deleted files</h2>
          <p>{query ? 'No deleted file matches.' : 'Nothing was ever deleted, or everything deleted is back.'}</p>
        </div>
      ) : (
        <>
          <p className="timeline-summary">
            {total} {total === 1 ? 'file' : 'files'}
          </p>
          <ul className="trash-list">
            {entries.map((d) => (
              <DeletedRow key={d.path} file={d} onPreview={() => onVersion(deletedEntry(d))} />
            ))}
          </ul>
          {deleted.hasNextPage && (
            <button type="button" className="button button-small history-more" disabled={deleted.isFetchingNextPage} onClick={() => void deleted.fetchNextPage()}>
              {deleted.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- page

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'changes', label: 'Changes' },
  { id: 'deleted', label: 'Deleted files' },
];

export default function VaultHistoryPage() {
  usePageTitle('Vault history');
  const [tab, setTab] = useState<Tab>('timeline');
  const [version, setVersion] = useState<HistoryEntry | null>(null);
  return (
    <div className="page vault-history-page">
      <header className="page-header">
        <h1 className="page-title">Vault history</h1>
      </header>
      <div className="segmented timeline-tabs" role="tablist" aria-label="Vault history">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'timeline' ? <Timeline onVersion={setVersion} /> : tab === 'changes' ? <Changes /> : <Deleted onVersion={setVersion} />}
      {version && <HistoryVersion entry={version} currentPath={version.path} onClose={() => setVersion(null)} />}
    </div>
  );
}
