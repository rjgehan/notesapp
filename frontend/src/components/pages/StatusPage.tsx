// `/x/status` (ROADMAP item 38, DESIGN §6.18.1), a page registered through registerPage: the server
// at a glance, from /api/status (live through status.changed) and /api/status/details (refreshed
// every 30 s while the page is open). Problems are listed first; each card then says what is
// running and how it is doing.
import { CircleAlert, CircleCheck, CloudUpload, GitCommitHorizontal, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { useStatus, useStatusDetails } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { StatusDetails, StatusResponse } from '../../api/types';
import { runCommand } from '../../features/commands';
import { formatBytes, formatDateTime, formatRelative, formatSince } from '../../features/format';
import { formatLimit } from '../../features/largeFiles';
import { mirrorConfigured, mirrorSummary, pushMirrorNow } from '../../features/mirror';
import { openPath } from '../../features/navigation';
import { aotCacheLabel, alertsSummary, backupSummary, formatUptime, LOW_FREE_BYTES, statusProblems, type Problem } from '../../features/opsStatus';
import { pageBuild } from '../../state/buildCheck';
import { useUi } from '../../state/ui';
import { usePageTitle } from './usePageTitle';

/** The current time, ticking every `ms`, so relative times stay true while the page is open. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** "1 folder", "3 folders", with the number formatted for the locale. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="about-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const id = useId();
  return (
    <section className="status-card" aria-labelledby={id}>
      <h2 id={id} className="status-card-title">
        {title}
      </h2>
      <dl className="about-list">{children}</dl>
      {actions && <div className="status-card-actions">{actions}</div>}
    </section>
  );
}

function When({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <>never</>;
  return <time dateTime={iso} title={formatDateTime(iso)}>{formatRelative(iso, now)}</time>;
}

function Summary({ problems, loaded }: { problems: Problem[]; loaded: boolean }) {
  if (!loaded) return null;
  if (problems.length === 0) {
    return (
      <p className="status-summary is-ok" role="status">
        <CircleCheck size={16} aria-hidden /> Everything is working.
      </p>
    );
  }
  return (
    <ul className="status-summary" aria-label="Problems">
      {problems.map((p) => (
        <li key={p.text} className={`status-problem is-${p.level}`}>
          {p.level === 'error' ? <CircleAlert size={16} aria-hidden /> : <TriangleAlert size={16} aria-hidden />}
          <span>{p.text}</span>
        </li>
      ))}
    </ul>
  );
}

const GIT_STATE: Record<StatusResponse['git']['state'], string> = {
  ready: 'working',
  importing: 'committing the existing files (startup)',
  failing: 'failing; commits are retried with backoff',
  disabled: 'off',
};

const WATCHER: Record<StatusResponse['watcher']['mode'], string> = {
  inotify: 'watching for changes made outside the app',
  polling: 'the watcher failed; a rescan every 5 minutes finds outside changes',
  disabled: 'off; a rescan every 5 minutes finds outside changes',
};

function ServerCard({ status, details, now }: { status: StatusResponse; details: StatusDetails | undefined; now: number }) {
  const runtime = details?.runtime;
  return (
    <Card title="Server">
      <Row label="Version">
        <code>{status.appVersion}</code> · build <code>{status.buildSha.slice(0, 12)}</code>
      </Row>
      <Row label="This page">
        <code>{pageBuild.slice(0, 12)}</code>
      </Row>
      <Row label="Up for">
        <span title={formatDateTime(status.startedAt)}>{formatUptime(status.startedAt, now)}</span>
      </Row>
      {runtime && (
        <>
          <Row label="Java">{`${runtime.javaVersion}${runtime.javaVendor ? ` (${runtime.javaVendor})` : ''}`}</Row>
          <Row label="AOT cache">{aotCacheLabel(runtime.aotCache)}</Row>
          <Row label="Memory">{`${formatBytes(runtime.heapUsedBytes)} of ${formatBytes(runtime.heapMaxBytes)} heap · ${runtime.processors} ${runtime.processors === 1 ? 'CPU' : 'CPUs'}`}</Row>
        </>
      )}
    </Card>
  );
}

function VaultCard({ status, now }: { status: StatusResponse; now: number }) {
  const { vault, index, watcher } = status;
  return (
    <Card title="Vault and index">
      <Row label="Contents">{`${count(vault.notes, 'note')} · ${count(vault.files, 'file')} · ${count(vault.folders, 'folder')} · ${formatBytes(vault.bytes)}`}</Row>
      <Row label="Index">
        built in {index.builtInMs.toLocaleString()} ms at startup · last rescan <When iso={index.lastRescanAt} now={now} />
      </Row>
      <Row label="File watcher">{WATCHER[watcher.mode]}</Row>
      {vault.skipped.length > 0 && (
        <Row label="Not shown">
          <ul className="status-list">
            {vault.skipped.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code> <span className="muted">({s.reason === 'unsafe-name' ? 'unsafe name' : 'same name as another file after normalization'})</span>
              </li>
            ))}
          </ul>
        </Row>
      )}
      {vault.unwritableDirs.length > 0 && (
        <Row label="Not writable">
          <ul className="status-list">
            {vault.unwritableDirs.map((d) => (
              <li key={d}>
                <code>{d}</code>
              </li>
            ))}
          </ul>
        </Row>
      )}
    </Card>
  );
}

function HistoryCard({ status, details, now }: { status: StatusResponse; details: StatusDetails | undefined; now: number }) {
  const git = status.git;
  const extra = details?.git;
  const large = git.largeFiles;
  const actions = (
    <>
      {git.enabled && git.pendingPaths > 0 && (
        <button type="button" className="button" onClick={() => runCommand('history.commitNow', { activePath: null })}>
          <GitCommitHorizontal size={14} aria-hidden /> Commit now
        </button>
      )}
      {mirrorConfigured(status) && (
        <button type="button" className="button" onClick={() => void pushMirrorNow()}>
          <CloudUpload size={14} aria-hidden /> Push to the mirror
        </button>
      )}
    </>
  );
  return (
    <Card title="History" actions={(git.enabled && git.pendingPaths > 0) || mirrorConfigured(status) ? actions : undefined}>
      <Row label="State">
        {!git.enabled ? `off${git.reason ? `: ${git.reason}` : ''}` : git.state === 'failing' && git.failingSince ? `failing ${formatSince(git.failingSince, now)}; commits are retried with backoff` : GIT_STATE[git.state]}
        {git.state === 'failing' && git.lastError && <div className="status-error">{git.lastError}</div>}
      </Row>
      {git.enabled && (
        <>
          <Row label="Commits">
            {extra ? (
              <>
                {extra.commits === null ? 'unknown' : extra.commits.toLocaleString()} · {extra.commitsThisRun.toLocaleString()} since the server started
                {extra.failedCommitsThisRun > 0 && <span className={git.state === 'failing' ? 'status-error' : undefined}> · {count(extra.failedCommitsThisRun, 'failed attempt')}</span>}
              </>
            ) : (
              '…'
            )}
          </Row>
          <Row label="Last commit">
            {git.lastCommitAt ? <When iso={git.lastCommitAt} now={now} /> : 'none since the server started'}
            {git.pendingPaths > 0 && (
              <>
                {' '}
                · {git.pendingPaths} {git.pendingPaths === 1 ? 'file' : 'files'} waiting{git.nextCommitAt ? <>, next commit <When iso={git.nextCommitAt} now={now} /></> : null}
              </>
            )}
          </Row>
          {status.disk.repoBytes !== null && <Row label="Size">{formatBytes(status.disk.repoBytes)}</Row>}
          <Row label="Kept out">
            {large.limitBytes === null ? (
              'nothing: every file is versioned'
            ) : (
              <>
                {large.files === 0 ? 'no files' : `${large.files} ${large.files === 1 ? 'file' : 'files'} (${formatBytes(large.bytes)})`} larger than {formatLimit(large.limitBytes)}
                {extra && extra.largeFiles.length > 0 && (
                  <ul className="status-list status-files">
                    {extra.largeFiles.map((f) => (
                      <li key={f.path}>
                        <button type="button" className="status-file-link" onClick={() => openPath(f.path)}>
                          {f.path}
                        </button>{' '}
                        <span className="muted">{formatBytes(f.bytes)}</span>
                      </li>
                    ))}
                    {extra.largeFilesTruncated && <li className="muted">and more</li>}
                  </ul>
                )}
              </>
            )}
          </Row>
        </>
      )}
      <Row label="Mirror">{mirrorSummary(status.mirror, now)}</Row>
    </Card>
  );
}

function StorageCard({ status, details }: { status: StatusResponse; details: StatusDetails | undefined }) {
  const free = status.disk.freeBytes;
  const total = details?.disk.totalBytes ?? null;
  const used = total !== null ? Math.max(0, total - free) : null;
  const percent = total ? Math.min(100, Math.round(((used ?? 0) / total) * 100)) : null;
  return (
    <Card title="Disk">
      <Row label="Free">
        <span className={free < LOW_FREE_BYTES ? 'status-error' : undefined}>{formatBytes(free)}</span>
        {total !== null && ` of ${formatBytes(total)}`}
        {percent !== null && (
          <div
            className={`status-meter${free < LOW_FREE_BYTES ? ' is-low' : ''}`}
            role="meter"
            aria-label="Disk space used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% used`}
          >
            <div className="status-meter-bar" style={{ width: `${percent}%` }} />
          </div>
        )}
      </Row>
      <Row label="Uploads">{free < LOW_FREE_BYTES ? 'refused: less than 1 GB free' : 'accepted'}</Row>
    </Card>
  );
}

const CONNECTION = { live: 'live', reconnecting: 'reconnecting…', offline: 'offline' } as const;

function SyncCard({ details }: { details: StatusDetails | undefined }) {
  const connection = useUi((s) => s.connection);
  return (
    <Card title="Live sync">
      <Row label="Connected">{details ? `${details.events.clients} ${details.events.clients === 1 ? 'tab or window' : 'tabs and windows'}, this one included` : '…'}</Row>
      <Row label="This device">{CONNECTION[connection]}</Row>
    </Card>
  );
}

function BackupCard({ details, now }: { details: StatusDetails; now: number }) {
  const backup = details.backup;
  return (
    <Card title="Backups">
      <Row label="State">
        <span className={backup.state === 'failed' || backup.state === 'stale' ? 'status-error' : undefined}>{backupSummary(backup, now)}</span>
      </Row>
      {backup.state !== 'unknown' && (
        <>
          <Row label="Last run">
            <When iso={backup.lastRun} now={now} />
          </Row>
          <Row label="Last success">
            <When iso={backup.lastSuccess} now={now} />
          </Row>
          {backup.snapshot && (
            <Row label="Snapshot">
              <code>{backup.snapshot}</code>
            </Row>
          )}
          <Row label="Off site">{backup.offsite === 'off' ? 'not set up' : (backup.offsite ?? 'unknown')}</Row>
          {backup.failures && (
            <Row label="Failures">
              <span className="status-error status-pre">{backup.failures}</span>
            </Row>
          )}
        </>
      )}
    </Card>
  );
}

function AlertsCard({ details, now }: { details: StatusDetails; now: number }) {
  const alerts = details.alerts;
  return (
    <Card title="App alerts">
      <Row label="ntfy">
        <span className={alerts.state === 'error' ? 'status-error' : undefined}>{alertsSummary(alerts)}</span>
      </Row>
      {alerts.state === 'on' && (
        <Row label="Sent">
          {alerts.sent.toLocaleString()} since the server started
          {alerts.dropped > 0 && ` · ${alerts.dropped.toLocaleString()} held back by the rate limit`}
          {alerts.lastSentAt && (
            <>
              {' '}
              · last <When iso={alerts.lastSentAt} now={now} />
            </>
          )}
        </Row>
      )}
      {alerts.lastError && (
        <Row label="Last error">
          <span className="status-error">{alerts.lastError}</span> {alerts.lastErrorAt && <When iso={alerts.lastErrorAt} now={now} />}
        </Row>
      )}
      <Row label="Problems logged">
        {alerts.recent.length === 0 ? (
          'none since the server started'
        ) : (
          <ul className="status-list">
            {alerts.recent.map((r) => (
              <li key={r.marker}>
                <code>{r.marker}</code> × {r.count.toLocaleString()} · last <When iso={r.lastAt} now={now} />
              </li>
            ))}
          </ul>
        )}
      </Row>
    </Card>
  );
}

export default function StatusPage() {
  usePageTitle('Status');
  const statusQuery = useStatus();
  const detailsQuery = useStatusDetails();
  const now = useNow(30_000);
  const status = statusQuery.data;
  const details = detailsQuery.data;
  const error = statusQuery.error ?? detailsQuery.error;
  const fetching = statusQuery.isFetching || detailsQuery.isFetching;
  const updatedAt = Math.max(statusQuery.dataUpdatedAt, detailsQuery.dataUpdatedAt);

  return (
    <div className="page status-page">
      <header className="page-header">
        <h1 className="page-title">Status</h1>
        <div className="status-refresh">
          {updatedAt > 0 && <span className="muted">Updated {formatRelative(updatedAt, now)}</span>}
          <button
            type="button"
            className="button"
            disabled={fetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.status() })}
          >
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
        </div>
      </header>
      {error && <p className="field-error">{errorMessage(error)}</p>}
      <Summary problems={statusProblems(status, details, now)} loaded={!!status && !!details} />
      {status ? (
        <div className="status-grid">
          <ServerCard status={status} details={details} now={now} />
          <HistoryCard status={status} details={details} now={now} />
          <VaultCard status={status} now={now} />
          <StorageCard status={status} details={details} />
          {details && <BackupCard details={details} now={now} />}
          {details && <AlertsCard details={details} now={now} />}
          <SyncCard details={details} />
        </div>
      ) : (
        !error && <div className="view-loading" aria-busy="true" />
      )}
    </div>
  );
}
