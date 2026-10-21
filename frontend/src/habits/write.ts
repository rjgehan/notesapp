// Check-ins and habit changes are edits of notes (DESIGN §6.35): a property of the habit note's
// frontmatter, or of a daily note. A note open on this device is edited through its session (so
// its editor, drafts and autosave stay in charge); any other note is read, edited and saved with
// its version, and a conflict re-applies the edit to the newer text, which suits edits that are
// set operations ("add this day", "set this property"). Edits of one note run one after another.
import { isVersionConflict } from '../api/client';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { detectEol, fromLf, toLf } from '../features/eol';
import { documents } from '../sync/instance';
import { applyWriteResult } from '../sync/treePatch';
import { getProperty, setProperty } from './frontmatterEdit';

const chains = new Map<string, Promise<void>>();
const ATTEMPTS = 4;

export class NoteBusyError extends Error {}

/** Applies `edit` (LF text in, LF text out) to the note at `path`. */
export function editNote(path: string, edit: (text: string) => string): Promise<void> {
  const previous = chains.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => apply(path, edit));
  chains.set(path, next);
  void next.finally(() => {
    if (chains.get(path) === next) chains.delete(path);
  }).catch(() => {});
  return next;
}

async function apply(path: string, edit: (text: string) => string): Promise<void> {
  const session = documents.get(path);
  if (session && session.currentStatus !== 'loading' && session.currentStatus !== 'error') {
    if (session.currentStatus === 'conflict' || session.currentStatus === 'deleted' || !session.isEditable()) {
      throw new NoteBusyError(session.currentStatus === 'conflict' ? `${path} has a conflict to resolve first` : `${path} cannot be changed here right now`);
    }
    const text = session.getText();
    const out = edit(text);
    if (out !== text) {
      session.setText(out);
      await session.flush();
    }
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const file = await api.readFile(path);
    const eol = detectEol(file.content);
    const text = toLf(file.content);
    const out = edit(text);
    if (out === text) return;
    const content = fromLf(out, eol);
    try {
      applyWriteResult(queryClient, await api.saveFile(path, { content, baseVersion: file.version }), content);
      return;
    } catch (e) {
      if (!isVersionConflict(e) || attempt >= ATTEMPTS) throw e;
    }
  }
}

/** The habit note's `entries` with `day` added or removed (sorted, once each). */
export function withEntry(text: string, day: string, done: boolean): string {
  return editEntries(text, (days) => (done ? days.add(day) : days.delete(day)));
}

function editEntries(text: string, change: (days: Set<string>) => unknown): string {
  const value = getProperty(text, 'entries');
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const current = [...new Set(list.map((v) => (typeof v === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(v.trim())?.[0] : undefined)).filter((v): v is string => !!v))].sort();
  const days = new Set(current);
  change(days);
  const next = [...days].sort();
  if (value !== undefined && next.length === current.length && next.every((d, i) => d === current[i])) return text;
  return setProperty(text, 'entries', next);
}
