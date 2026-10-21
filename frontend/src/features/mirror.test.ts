import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { MirrorStatus, StatusResponse } from '../api/types';
import { useToasts } from '../state/toasts';
import { mirrorConfigured, mirrorMisconfigured, mirrorSummary, mirrorWarning, mirrorWarningDetail, pushMirrorNow } from './mirror';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

const READY: MirrorStatus = {
  state: 'ready',
  reason: null,
  remote: 'https://github.com/me/vault.git',
  branch: 'main',
  pushing: false,
  pushedCommit: null,
  lastPushAt: null,
  nextPushAt: null,
  lastError: null,
  failingSince: null,
};

const DISABLED: MirrorStatus = { ...READY, state: 'disabled', reason: 'not configured', remote: null, branch: null };

function status(mirror: MirrorStatus): StatusResponse {
  return { mirror } as StatusResponse;
}

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  useToasts.setState({ toasts: [] });
});

describe('mirror warning (DESIGN §6.18)', () => {
  it('says nothing while the mirror works, is off, or the status is unknown', () => {
    expect(mirrorWarning(undefined)).toBeNull();
    expect(mirrorWarning(READY)).toBeNull();
    expect(mirrorWarning({ ...READY, pushing: true })).toBeNull();
    expect(mirrorWarning(DISABLED)).toBeNull();
  });

  it('says how long pushes have been failing', () => {
    const failing: MirrorStatus = { ...READY, state: 'failing', lastError: 'not authorized', failingSince: '2026-10-17T10:00:00.000Z' };
    expect(mirrorWarning(failing, NOW)).toBe('Mirror is not being updated (for 2 hours)');
    expect(mirrorWarning({ ...failing, failingSince: null }, NOW)).toBe('Mirror is not being updated');
    expect(mirrorWarningDetail(failing)).toBe('not authorized\nClick to push now.');
  });

  it('warns about a mirror that was set up but whose settings cannot be used', () => {
    const ssh: MirrorStatus = { ...DISABLED, reason: 'the mirror URL is not a valid URL', remote: 'git@github.com:me/vault.git' };
    expect(mirrorMisconfigured(ssh)).toBe(true);
    expect(mirrorWarning(ssh, NOW)).toBe('Mirror is off: the mirror URL is not a valid URL');
    expect(mirrorWarningDetail(ssh)).toMatch(/^Nothing is pushed until/);
    const withToken: MirrorStatus = { ...DISABLED, reason: 'the mirror URL must be a plain https:// URL, without credentials, query or fragment', remote: 'https://github.com/me/vault.git' };
    expect(mirrorWarning(withToken, NOW)).toMatch(/^Mirror is off: the mirror URL must be a plain https:\/\/ URL/);
    // Not set up at all, or off because history is off (which has its own warning): nothing to say.
    expect(mirrorMisconfigured(DISABLED)).toBe(false);
    expect(mirrorWarning({ ...DISABLED, reason: 'history is disabled', remote: 'https://github.com/me/vault.git' })).toBeNull();
    // Still nothing to push.
    expect(mirrorConfigured(status(ssh))).toBe(false);
  });

  it('explains a diverged mirror and that NotesApp never forces', () => {
    const diverged: MirrorStatus = { ...READY, state: 'diverged', lastError: "the mirror has commits that are not in the vault's history" };
    expect(mirrorWarning(diverged, NOW)).toBe('Mirror stopped: it has commits this vault does not');
    expect(mirrorWarningDetail(diverged)).toContain('never force-pushes');
  });
});

describe('mirror summary (Settings, About)', () => {
  it('is "off" unless a configuration problem needs saying', () => {
    expect(mirrorSummary(DISABLED)).toBe('off');
    expect(mirrorSummary({ ...DISABLED, reason: 'the mirror URL must start with https://' })).toBe('off: the mirror URL must start with https://');
  });

  it('names the remote, the last push and the next one', () => {
    const summary = mirrorSummary({ ...READY, lastPushAt: '2026-10-17T11:55:00.000Z', nextPushAt: '2026-10-17T12:08:00.000Z' }, NOW);
    expect(summary).toMatch(/^https:\/\/github\.com\/me\/vault\.git · last push 5 minutes ago · next push in 8 minutes$/);
    expect(mirrorSummary({ ...READY, pushing: true, nextPushAt: '2026-10-17T12:08:00.000Z' }, NOW)).toBe('https://github.com/me/vault.git · pushing…');
  });

  it('shows the error of a failing mirror', () => {
    expect(mirrorSummary({ ...READY, state: 'failing', lastError: 'connection failed' }, NOW)).toBe('not being updated: connection failed');
    expect(mirrorSummary({ ...READY, state: 'diverged', lastError: null }, NOW)).toBe('stopped: it has commits this vault does not');
  });
});

describe('pushing the mirror now', () => {
  it('is offered only when the server has a mirror', () => {
    expect(mirrorConfigured(undefined)).toBe(false);
    expect(mirrorConfigured(status(DISABLED))).toBe(false);
    expect(mirrorConfigured(status({ ...READY, state: 'diverged' }))).toBe(true);
    queryClient.setQueryData(queryKeys.status(), status(READY));
    expect(mirrorConfigured()).toBe(true);
  });

  it('asks the server and says so; the result arrives with status.changed', async () => {
    const push = vi.spyOn(api, 'pushMirror').mockResolvedValue({ ...READY, pushing: true });
    await pushMirrorNow();
    expect(push).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Pushing to the mirror…']);
  });

  it('shows the server refusing a push', async () => {
    vi.spyOn(api, 'pushMirror').mockRejectedValue(
      new ApiError({ type: 'urn:notesapp:problem:bad-request', title: 'Bad request', status: 400, code: 'bad-request', detail: 'The mirror is off: not configured' }),
    );
    await pushMirrorNow();
    const [shown] = useToasts.getState().toasts;
    expect(shown.kind).toBe('error');
  });
});
