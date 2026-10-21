// The status page (ROADMAP item 38, DESIGN §6.18.1): what /api/status and /api/status/details say,
// in words, and the list of problems at the top of the page.
import type { AlertsStatus, BackupStatus, StatusDetails, StatusResponse } from '../api/types';
import { formatBytes, formatRelative, formatSince } from './format';
import { mirrorWarning } from './mirror';

/** Uploads are refused below this much free space (notes.limits.min-free-space). */
export const LOW_FREE_BYTES = 1024 ** 3;

export interface Problem {
  level: 'error' | 'warning';
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "3 days, 4 hours", "5 hours, 12 minutes", "12 minutes", "less than a minute". */
export function formatUptime(startedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'less than a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${plural(days, 'day')}, ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours > 0) return mins > 0 ? `${plural(hours, 'hour')}, ${plural(mins, 'minute')}` : plural(hours, 'hour');
  return plural(mins, 'minute');
}

export function aotCacheLabel(state: StatusDetails['runtime']['aotCache']): string {
  switch (state) {
    case 'in-use':
      return 'in use (faster start)';
    case 'not-used':
      return 'not used: this JVM could not use the image’s cache';
    case 'off':
      return 'off';
    default:
      return 'unknown';
  }
}

/** One line about the backups: "Last backup 6 hours ago", "Failed …", "None for 3 days". */
export function backupSummary(backup: BackupStatus, now = Date.now()): string {
  switch (backup.state) {
    case 'ok':
      return backup.lastSuccess ? `last backup ${formatRelative(backup.lastSuccess, now)}` : 'working';
    case 'failed':
      return `the last run failed${backup.lastRun ? ` (${formatRelative(backup.lastRun, now)})` : ''}`;
    case 'stale':
      return backup.lastSuccess ? `no backup ${formatSince(backup.lastSuccess, now)}` : 'no successful backup yet';
    default:
      return backup.reason ?? 'unknown';
  }
}

/** One line about the app-error alerts. */
export function alertsSummary(alerts: AlertsStatus): string {
  if (alerts.state === 'on') return `sent to ntfy at ${alerts.server ?? 'the configured server'}`;
  if (alerts.state === 'error') return alerts.reason ?? 'ntfy.json cannot be used';
  return alerts.reason === 'not configured' ? 'off: no ntfy.json' : `off${alerts.reason ? `: ${alerts.reason}` : ''}`;
}

/** Everything that needs attention, worst first; empty when all is well. */
export function statusProblems(status: StatusResponse | undefined, details: StatusDetails | undefined, now = Date.now()): Problem[] {
  const problems: Problem[] = [];
  if (status) {
    const git = status.git;
    if (git.state === 'failing') {
      problems.push({ level: 'error', text: `History is not being saved${git.failingSince ? ` (${formatSince(git.failingSince, now)})` : ''}${git.lastError ? `: ${git.lastError}` : ''}` });
    } else if (!git.enabled && git.reason !== 'disabled by configuration') {
      problems.push({ level: 'warning', text: `History is off: ${git.reason ?? 'unknown reason'}` });
    }
    if (status.disk.freeBytes < LOW_FREE_BYTES) {
      problems.push({ level: 'error', text: `Only ${formatBytes(status.disk.freeBytes)} free on the vault’s disk: uploads are refused` });
    }
    const mirror = mirrorWarning(status.mirror, now);
    if (mirror) problems.push({ level: 'warning', text: mirror });
    if (status.watcher.mode === 'polling') {
      problems.push({ level: 'warning', text: 'The file watcher failed: changes made outside the app appear within 5 minutes' });
    }
    if (status.settings.readOnly) {
      problems.push({ level: 'warning', text: `Settings are read-only${status.settings.reason ? `: ${status.settings.reason}` : ''}` });
    }
    if (status.vault.unwritableDirs.length > 0) {
      problems.push({ level: 'warning', text: `${plural(status.vault.unwritableDirs.length, 'folder')} cannot be written by the server` });
    }
    if (status.vault.skipped.length > 0) {
      problems.push({ level: 'warning', text: `${plural(status.vault.skipped.length, 'file')} on disk ${status.vault.skipped.length === 1 ? 'is' : 'are'} not shown in the app (see Vault)` });
    }
  }
  if (details) {
    if (details.backup.state === 'failed' || details.backup.state === 'stale') {
      problems.push({ level: details.backup.state === 'failed' ? 'error' : 'warning', text: `Backups: ${backupSummary(details.backup, now)}` });
    }
    if (details.alerts.state === 'error') {
      problems.push({ level: 'warning', text: `App alerts are off: ${details.alerts.reason ?? 'ntfy.json cannot be used'}` });
    } else if (details.alerts.state === 'on' && details.alerts.lastErrorAt && (!details.alerts.lastSentAt || details.alerts.lastSentAt < details.alerts.lastErrorAt)) {
      problems.push({ level: 'warning', text: `The last app alert could not be sent: ${details.alerts.lastError ?? 'unknown error'}` });
    }
  }
  return problems.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}
