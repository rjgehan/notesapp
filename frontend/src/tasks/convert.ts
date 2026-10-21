// Convert checkbox to task (ROADMAP item 4, "Integration with notes"): the `- [ ]` line under the
// cursor becomes a task in the Inbox (`Tasks/Inbox.tasks`, which the server creates when needed),
// and the line keeps its list marker with a link to the task in place of the checkbox:
//   - [ ] Pay rent 📅 2026-11-01 ⏫   →   - [[Inbox.tasks#^01JC…|Pay rent]]
// The task is created first; the line is replaced only afterwards, and only if it is still the
// same text (it is followed through edits made meanwhile, editor/tracked.ts), so a failed request
// or a line edited during it never loses what was written. The Obsidian Tasks plugin's emoji
// fields (📅 due, ⏳/🛫 start, ⏫🔼🔽 priority, 🔁 recurrence) become the task's fields.
import { currentSettings, currentTree } from '../api/hooks';
import type { CreateTaskRequest, LocalDate, Task, TaskPriority } from '../api/types';
import { activeEditor } from '../editor/activeEditor';
import { assembleLink, linkText } from '../features/links';
import { activePath } from '../features/navigation';
import { isNotePath } from '../features/paths';
import { toast } from '../state/toasts';
import { documents } from '../sync/instance';
import type { DocumentSession } from '../sync/DocumentSession';
import { loadRecurrence } from './loadRecurrence';
import { createTask, inboxList } from './mutations';
import { taskStore } from './store';
import { taskSubpath } from './taskLinks';
import { openTaskDetail } from './ui/state';
import { titleSegments } from './ui/display';

/** An open checkbox: the list marker (with indentation and quote markers), then `[ ]` and the text. */
const OPEN_CHECKBOX = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+)\[ \](?:\s+(.*))?$/;

export const INBOX_PATH = 'Tasks/Inbox.tasks';

export interface CheckboxLine {
  /** Everything before `[ ]`: indentation, quote markers and the list marker. */
  prefix: string;
  text: string;
}

/** The open checkbox on a line, or null (a checked one, a plain list item, no text). */
export function parseCheckboxLine(line: string): CheckboxLine | null {
  const m = OPEN_CHECKBOX.exec(line);
  const text = m?.[2]?.trim() ?? '';
  return m && text ? { prefix: m[1], text } : null;
}

export interface CheckboxFields {
  title: string;
  due: LocalDate | null;
  start: LocalDate | null;
  priority: TaskPriority;
  /** The words after 🔁 ("every week"), to read with rrule. */
  repeat: string | null;
}

const VS = '\\uFE0F?';
const DATE_FIELD = new RegExp(`(📅|⏳|🛫|➕|✅|❌)${VS}\\s*(\\d{4}-\\d{2}-\\d{2})`, 'gu');
const PRIORITY = new RegExp(`(🔺|⏫|🔼|🔽|⏬)${VS}`, 'gu');
// The rule's words run to the next field, or to a #tag (which stays in the title).
const REPEAT = new RegExp(`🔁${VS}\\s*([^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔🏁#]*)`, 'u');
const PRIORITIES: Record<string, TaskPriority> = { '🔺': 3, '⏫': 3, '🔼': 2, '🔽': 1, '⏬': 1 };

/** Reads the Obsidian Tasks plugin's emoji fields out of a checkbox's text. */
export function parseCheckboxText(text: string): CheckboxFields {
  const dates = new Map<string, LocalDate>();
  for (const m of text.matchAll(DATE_FIELD)) if (!dates.has(m[1])) dates.set(m[1], m[2]);
  // ➕ created, ✅ done and ❌ cancelled dates have no place in an open task: they go too.
  let rest = text.replace(DATE_FIELD, ' ');
  let priority: TaskPriority = 0;
  for (const m of rest.matchAll(PRIORITY)) priority = priority || PRIORITIES[m[1]];
  rest = rest.replace(PRIORITY, ' ');
  let repeat: string | null = null;
  const r = REPEAT.exec(rest);
  if (r && r[1].trim()) {
    repeat = r[1].trim();
    rest = rest.slice(0, r.index) + ' ' + rest.slice(r.index + r[0].length);
  }
  const title = rest.replace(/\s+/g, ' ').trim();
  return {
    title: title || text.replace(/\s+/g, ' ').trim(),
    due: dates.get('📅') ?? null,
    start: dates.get('⏳') ?? dates.get('🛫') ?? null,
    priority,
    repeat,
  };
}

/** The text of a link to the task: the title with `[[links]]` as their text, without brackets or pipes. */
export function linkDisplay(title: string): string {
  const plain = titleSegments(title)
    .map((s) => s.text)
    .join('');
  return plain.replace(/[[\]|]/g, '').replace(/\s+/g, ' ').trim();
}

/** A link to a task in the configured style, as `sourcePath` writes it: `[[Inbox.tasks#^<id>|Title]]`. */
export function taskLink(listPath: string, taskId: string, title: string, sourcePath: string): string {
  const settings = currentSettings().files;
  const style = settings.useWikilinks ? 'wiki' : 'markdown';
  const text = linkText(listPath, sourcePath, settings.newLinkFormat, style, currentTree().links);
  return assembleLink(text, style, listPath, { subpath: taskSubpath(taskId), display: linkDisplay(title) || null });
}

/** An open checkbox line of a note's session. */
export interface CheckboxAt {
  session: DocumentSession;
  path: string;
  from: number;
  to: number;
  line: CheckboxLine;
}

/** The open checkbox on the line of `pos` in a note's session, if there is one. */
export function checkboxAt(session: DocumentSession, path: string, pos: number): CheckboxAt | null {
  if (!session.isEditable()) return null;
  const line = session.editorState.doc.lineAt(pos);
  const parsed = parseCheckboxLine(line.text);
  return parsed ? { session, path, from: line.from, to: line.to, line: parsed } : null;
}

/** The open checkbox under the cursor of the active note's editor, if there is one. */
export function checkboxAtCursor(): CheckboxAt | null {
  const view = activeEditor();
  const path = activePath();
  if (!view || !path || !isNotePath(path)) return null;
  const session = documents.get(path);
  return session ? checkboxAt(session, path, session.editorState.selection.main.head) : null;
}

/**
 * Converts the checkbox under the cursor. Resolves to the created task's id, or null when there
 * was nothing to convert or the task could not be created (the line then stays as it was).
 */
export async function convertCheckboxToTask(): Promise<string | null> {
  const at = checkboxAtCursor();
  if (!at) {
    toast('Put the cursor on an open checkbox (- [ ] …) to convert it to a task.');
    return null;
  }
  return convertCheckbox(at);
}

/** Converts one checkbox line (see the file comment); `create` is createTask (tests pass their own). */
export async function convertCheckbox(at: CheckboxAt, create: (req: CreateTaskRequest) => Promise<Task | null> = (req) => createTask(req)): Promise<string | null> {
  const { session, path, line } = at;
  const original = session.editorState.doc.sliceString(at.from, at.to);
  const tracked = session.trackRange(at.from, at.to);
  if (tracked === null) return null;
  try {
    const fields = parseCheckboxText(line.text);
    const req: CreateTaskRequest = { title: fields.title };
    if (fields.due) req.due = fields.due;
    if (fields.start) req.start = fields.start;
    if (fields.priority) req.priority = fields.priority;
    if (fields.repeat) {
      const rule = await loadRecurrence().then(
        (m) => m.ruleFromText(fields.repeat!.toLowerCase().startsWith('every') ? fields.repeat! : `every ${fields.repeat}`),
        () => null,
      );
      // A rule this app cannot read stays in the title, so nothing written is lost.
      if (rule) req.recurrence = { rrule: rule, from: 'due' };
      else req.title = `${req.title} 🔁 ${fields.repeat}`;
    }
    const task = await create(req);
    const range = session.takeRange(tracked);
    if (!task) return null;
    const listPath = taskStore.list(task.listId)?.path ?? inboxList()?.path ?? INBOX_PATH;
    const listName = taskStore.list(task.listId)?.name ?? 'Inbox';
    const open = { label: 'Open', run: () => openTaskDetail(task.id) };
    const doc = session.editorState.doc;
    const intact = range !== null && session.isEditable() && range.to <= doc.length && doc.sliceString(range.from, range.to) === original && doc.lineAt(range.from).from === range.from && doc.lineAt(range.to).to === range.to;
    if (!intact) {
      toast(`Added “${task.title}” to ${listName}. The line changed meanwhile, so it was left in the note.`, { action: open, timeout: 12_000 });
      return task.id;
    }
    session.applyEdit({ from: range.from + line.prefix.length, to: range.to, insert: taskLink(listPath, task.id, task.title, path) }, { userEvent: 'input.convert' });
    toast(`Moved “${task.title}” to ${listName}`, { action: open });
    return task.id;
  } finally {
    session.takeRange(tracked);
  }
}
