import { describe, expect, it } from 'vitest';
import { MockVault } from '../api/mock/vault';
import type { StatusDetails, StatusResponse } from '../api/types';
import { aotCacheLabel, alertsSummary, backupSummary, formatUptime, LOW_FREE_BYTES, statusProblems } from './opsStatus';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

function healthy(): { status: StatusResponse; details: StatusDetails } {
  const vault = new MockVault();
  const details = vault.getStatusDetails();
  return {
    status: vault.getStatus(),
    details: {
      ...details,
      backup: { state: 'ok', reason: null, lastRun: ago(6 * HOUR), lastSuccess: ago(6 * HOUR), snapshot: '4f1c2a9b', offsite: 'ok', failures: null },
      alerts: { ...details.alerts, state: 'on', reason: null, server: 'https://ntfy.sh' },
    },
  };
}

describe('status page wording (ROADMAP item 38)', () => {
  it('formats the uptime in its two largest units', () => {
    expect(formatUptime(ago(20_000), NOW)).toBe('less than a minute');
    expect(formatUptime(ago(12 * 60_000), NOW)).toBe('12 minutes');
    expect(formatUptime(ago(HOUR), NOW)).toBe('1 hour');
    expect(formatUptime(ago(5 * HOUR + 12 * 60_000), NOW)).toBe('5 hours, 12 minutes');
    expect(formatUptime(ago(3 * 24 * HOUR + 4 * HOUR + 59_000), NOW)).toBe('3 days, 4 hours');
    expect(formatUptime(ago(24 * HOUR), NOW)).toBe('1 day');
  });

  it('describes the AOT cache, the backups and the alerts', () => {
    expect(aotCacheLabel('in-use')).toBe('in use (faster start)');
    expect(aotCacheLabel('not-used')).toMatch(/could not use/);
    expect(backupSummary({ state: 'ok', reason: null, lastRun: ago(6 * HOUR), lastSuccess: ago(6 * HOUR), snapshot: 'a', offsite: 'ok', failures: null }, NOW)).toBe('last backup 6 hours ago');
    expect(backupSummary({ state: 'stale', reason: null, lastRun: ago(50 * HOUR), lastSuccess: ago(50 * HOUR), snapshot: null, offsite: null, failures: null }, NOW)).toBe('no backup for 2 days');
    expect(backupSummary({ state: 'stale', reason: null, lastRun: ago(HOUR), lastSuccess: null, snapshot: null, offsite: null, failures: null }, NOW)).toBe('no successful backup yet');
    expect(backupSummary({ state: 'failed', reason: null, lastRun: ago(2 * HOUR), lastSuccess: null, snapshot: null, offsite: null, failures: 'x' }, NOW)).toBe('the last run failed (2 hours ago)');
    expect(backupSummary({ state: 'unknown', reason: 'No backup has reported here yet', lastRun: null, lastSuccess: null, snapshot: null, offsite: null, failures: null }, NOW)).toBe('No backup has reported here yet');
    const alerts = healthy().details.alerts;
    expect(alertsSummary(alerts)).toBe('sent to ntfy at https://ntfy.sh');
    expect(alertsSummary({ ...alerts, state: 'off', reason: 'not configured', server: null })).toBe('off: no ntfy.json');
    expect(alertsSummary({ ...alerts, state: 'off', reason: 'switched off in ntfy.json' })).toBe('off: switched off in ntfy.json');
    expect(alertsSummary({ ...alerts, state: 'error', reason: 'ntfy.json is not valid JSON' })).toBe('ntfy.json is not valid JSON');
  });

  it('finds no problems on a healthy server, and not before the data is loaded', () => {
    const { status, details } = healthy();
    expect(statusProblems(status, details, NOW)).toEqual([]);
    expect(statusProblems(undefined, undefined, NOW)).toEqual([]);
  });

  it('lists every problem, errors first', () => {
    const { status, details } = healthy();
    const broken: StatusResponse = {
      ...status,
      git: { ...status.git, state: 'failing', lastError: 'disk full', failingSince: ago(10 * 60_000) },
      disk: { ...status.disk, freeBytes: LOW_FREE_BYTES - 1 },
      mirror: { ...status.mirror, state: 'diverged', remote: 'https://github.com/me/vault.git' },
      watcher: { mode: 'polling' },
      settings: { readOnly: true, reason: 'written by a newer version' },
      vault: { ...status.vault, unwritableDirs: ['Root owned'], skipped: [{ name: 'a\\b.md', reason: 'unsafe-name' }] },
    };
    const problems = statusProblems(broken, {
      ...details,
      backup: { ...details.backup, state: 'stale', lastSuccess: ago(50 * HOUR) },
      alerts: { ...details.alerts, lastError: 'IOException: ntfy answered HTTP 403', lastErrorAt: ago(60_000), lastSentAt: null },
    }, NOW);
    expect(problems.map((p) => p.level)).toEqual(['error', 'error', 'warning', 'warning', 'warning', 'warning', 'warning', 'warning', 'warning']);
    const texts = problems.map((p) => p.text);
    expect(texts[0]).toBe('History is not being saved (for 10 minutes): disk full');
    expect(texts[1]).toMatch(/^Only .* free on the vault’s disk/);
    expect(texts).toContain('Mirror stopped: it has commits this vault does not');
    expect(texts).toContain('Settings are read-only: written by a newer version');
    expect(texts).toContain('1 folder cannot be written by the server');
    expect(texts).toContain('1 file on disk is not shown in the app (see Vault)');
    expect(texts).toContain('Backups: no backup for 2 days');
    expect(texts).toContain('The last app alert could not be sent: IOException: ntfy answered HTTP 403');
  });

  it('treats a failed backup as an error and an unusable ntfy.json as a warning', () => {
    const { status, details } = healthy();
    const problems = statusProblems(status, {
      ...details,
      backup: { ...details.backup, state: 'failed', lastRun: ago(HOUR) },
      alerts: { ...details.alerts, state: 'error', reason: 'ntfy.json needs a "topic"' },
    }, NOW);
    expect(problems).toEqual([
      { level: 'error', text: 'Backups: the last run failed (1 hour ago)' },
      { level: 'warning', text: 'App alerts are off: ntfy.json needs a "topic"' },
    ]);
  });

  it('lists a mirror that was set up but cannot run, and not one that was never set up', () => {
    const { status, details } = healthy();
    expect(status.mirror.state).toBe('disabled');
    const http: StatusResponse = { ...status, mirror: { ...status.mirror, state: 'disabled', reason: 'the mirror URL must start with https://', remote: 'http://github.com/me/vault.git' } };
    expect(statusProblems(http, details, NOW)).toEqual([{ level: 'warning', text: 'Mirror is off: the mirror URL must start with https://' }]);
    const never: StatusResponse = { ...status, mirror: { ...status.mirror, state: 'disabled', reason: 'not configured', remote: null } };
    expect(statusProblems(never, details, NOW)).toEqual([]);
  });

  it('does not count history switched off on purpose, or an alert error that a later send superseded', () => {
    const { status, details } = healthy();
    const off: StatusResponse = { ...status, git: { ...status.git, enabled: false, state: 'disabled', reason: 'disabled by configuration' } };
    expect(statusProblems(off, { ...details, alerts: { ...details.alerts, lastError: 'old', lastErrorAt: ago(2 * HOUR), lastSentAt: ago(HOUR) } }, NOW)).toEqual([]);
    const lfs: StatusResponse = { ...status, git: { ...status.git, enabled: false, state: 'disabled', reason: 'git-lfs is not supported' } };
    expect(statusProblems(lfs, details, NOW)).toEqual([{ level: 'warning', text: 'History is off: git-lfs is not supported' }]);
  });
});
