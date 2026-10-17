// The git mirror (ROADMAP item 2, DESIGN §6.18) as the UI shows it: the status-bar warning and
// "Push to the mirror now".
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { MirrorStatus, StatusResponse } from '../api/types';
import { toast } from '../state/toasts';
import { toastError } from './errors';
import { formatRelative, formatSince } from './format';

/** What is wrong with the mirror, without the subject: "not being updated (for 2 hours)"; null while it works or is off. */
function mirrorProblem(mirror: MirrorStatus, now: number): string | null {
  if (mirror.state === 'diverged') return 'stopped: it has commits this vault does not';
  if (mirror.state !== 'failing') return null;
  return mirror.failingSince ? `not being updated (${formatSince(mirror.failingSince, now)})` : 'not being updated';
}

/** The warning the status bar shows for the mirror; null while it works or is off. */
export function mirrorWarning(mirror: MirrorStatus | undefined, now = Date.now()): string | null {
  const problem = mirror ? mirrorProblem(mirror, now) : null;
  if (!problem) return null;
  return mirror?.state === 'diverged' ? `Mirror ${problem}` : `Mirror is ${problem}`;
}

/** A tooltip for the warning: the server's error, and what clicking does. */
export function mirrorWarningDetail(mirror: MirrorStatus): string {
  const fix = mirror.state === 'diverged' ? 'NotesApp never force-pushes. Fix the mirror, then click to push again.' : 'Click to push now.';
  return [mirror.lastError, fix].filter(Boolean).join('\n');
}

/** One line for Settings, About: where the mirror is and what it is doing. */
export function mirrorSummary(mirror: MirrorStatus, now = Date.now()): string {
  if (mirror.state === 'disabled') return mirror.reason && mirror.reason !== 'not configured' ? `off: ${mirror.reason}` : 'off';
  if (mirror.state !== 'ready') return [mirrorProblem(mirror, now), mirror.lastError].filter(Boolean).join(': ');
  const parts = [mirror.remote ?? 'on'];
  if (mirror.lastPushAt) parts.push(`last push ${formatRelative(mirror.lastPushAt, now)}`);
  if (mirror.pushing) parts.push('pushing…');
  else if (mirror.nextPushAt) parts.push(`next push ${formatRelative(mirror.nextPushAt, now)}`);
  return parts.join(' · ');
}

/** True when the server has a mirror configured, judged from the last /api/status. */
export function mirrorConfigured(status = queryClient.getQueryData<StatusResponse>(queryKeys.status())): boolean {
  return !!status && status.mirror.state !== 'disabled';
}

/** Asks the server to push now; it pushes in the background and announces the result with status.changed. */
export async function pushMirrorNow(): Promise<void> {
  try {
    await api.pushMirror();
    toast('Pushing to the mirror…');
  } catch (e) {
    toastError(e);
  } finally {
    void queryClient.invalidateQueries({ queryKey: queryKeys.status() });
  }
}
