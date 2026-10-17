// Daily notes (API.md §15.2, DESIGN §6.12): today's note in the browser's time zone, created from
// the configured template when missing; previous and next by strict date parsing of note names.
import { isProblem } from '../api/client';
import { api } from '../api/endpoints';
import { currentSettings, currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import type { DailyNotesSettings } from '../api/types';
import { findFileIgnoreCase } from '../api/vaultTree';
import { newIdempotencyKey } from '../state/clientId';
import { toast } from '../state/toasts';
import { applyWriteResult } from '../sync/treePatch';
import { dayjs, type Dayjs } from './dates';
import { openPath } from './navigation';
import { isNotePath, isWithin, joinPath, lastSegment } from './paths';
import { toastError } from './errors';

/** `name` may contain `/`, which creates subfolders. */
export function dailyNoteName(settings: Pick<DailyNotesSettings, 'format'>, now: Dayjs): string {
  return now.format(settings.format);
}

export function dailyNotePath(settings: Pick<DailyNotesSettings, 'format' | 'folder'>, now: Dayjs): string {
  return joinPath(settings.folder, dailyNoteName(settings, now) + '.md');
}

/** The date a daily note stands for: its path below the folder, without `.md`, parsed strictly. */
export function dailyNoteDate(path: string, settings: Pick<DailyNotesSettings, 'format' | 'folder'>): Dayjs | null {
  if (!isNotePath(path) || !isWithin(path, settings.folder) || path === settings.folder) return null;
  const rel = (settings.folder ? path.slice(settings.folder.length + 1) : path).slice(0, -3);
  const date = dayjs(rel, settings.format, true);
  return date.isValid() ? date : null;
}

/** The nearest existing daily note before (`-1`) or after (`1`) the one at `current`. */
export function adjacentDailyNote(paths: readonly string[], current: string, settings: Pick<DailyNotesSettings, 'format' | 'folder'>, direction: -1 | 1): string | null {
  const here = dailyNoteDate(current, settings);
  if (!here) return null;
  let best: { path: string; date: Dayjs } | null = null;
  for (const path of paths) {
    if (path === current) continue;
    const date = dailyNoteDate(path, settings);
    if (!date) continue;
    const diff = date.valueOf() - here.valueOf();
    if (diff === 0 || Math.sign(diff) !== direction) continue;
    if (!best || Math.abs(diff) < Math.abs(best.date.valueOf() - here.valueOf())) best = { path, date };
  }
  return best?.path ?? null;
}

export function isDailyNote(path: string | null): boolean {
  return path !== null && dailyNoteDate(path, currentSettings().dailyNotes) !== null;
}

/**
 * "Open today's daily note" (API.md §15.2): open it, or create it (201 and 409 both open it).
 * Resolves true when a note was opened; false when it failed (a toast says why).
 */
export async function openTodaysDailyNote(now: Dayjs = dayjs()): Promise<boolean> {
  const s = currentSettings().dailyNotes;
  const name = dailyNoteName(s, now);
  const path = joinPath(s.folder, name + '.md');
  const hit = findFileIgnoreCase(currentTree(), path);
  if (hit) {
    openPath(hit.path);
    return true;
  }
  let content = '';
  if (s.template) {
    try {
      // Templates (and the YAML library behind them) load on first use.
      const { renderTemplateFile } = await import('./templates');
      content = await renderTemplateFile(s.template, lastSegment(name));
    } catch (e) {
      if (isProblem(e, 'not-found')) toast('Daily note template not found', { kind: 'error' });
      else {
        toastError(e);
        return false;
      }
    }
  }
  try {
    const result = await api.createFile({ path, content, onConflict: 'fail' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, content);
    openPath(result.file.path, null, { newNote: true });
    return true;
  } catch (e) {
    if (isProblem(e, 'already-exists') || isProblem(e, 'case-collision')) {
      openPath(e.problem.existingPath ?? path);
      return true;
    }
    if (isProblem(e, 'invalid-path') || isProblem(e, 'invalid-name')) toast('Daily note format produces an invalid file name', { kind: 'error' });
    else toastError(e);
    return false;
  }
}

/** Previous (`-1`) or next (`1`) daily note from the open one. */
export function openAdjacentDailyNote(current: string, direction: -1 | 1): void {
  const s = currentSettings().dailyNotes;
  const next = adjacentDailyNote(
    currentTree().notes.map((n) => n.path),
    current,
    s,
    direction,
  );
  if (next) openPath(next);
  else toast(direction < 0 ? 'No earlier daily note' : 'No later daily note');
}
