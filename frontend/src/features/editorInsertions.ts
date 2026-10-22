// Insertions into the open note that leave the editor for a moment (a file picker, a name prompt),
// shared by the phone toolbar and the `/` menu (DESIGN §6.6.2, §6.16).
import type { EditorView } from '@codemirror/view';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { noteContext } from '../editor/context';
import { promptText } from '../state/dialogs';
import { newIdempotencyKey } from '../state/clientId';
import { documents } from '../sync/instance';
import { applyWriteResult } from '../sync/treePatch';
import { pickAndInsertAttachments, pickFiles } from './attachments';
import { dayjs } from './dates';
import { toastError } from './errors';
import { linkTo, newNoteFolder, validateNewName } from './fileOps';
import { isNotePath, joinPath } from './paths';
import type { DocumentSession } from '../sync/DocumentSession';

/** The session of the note `view` edits, when it is a note's editor (not a canvas card's). */
export function noteSessionOf(view: EditorView): DocumentSession | undefined {
  const ctx = view.state.facet(noteContext);
  return ctx && isNotePath(ctx.path()) ? documents.get(ctx.path()) : undefined;
}

/** Picks images and inserts their embeds where the cursor is (the session remembers it across the picker). */
export function pickAndInsertImages(view: EditorView): void {
  const ctx = view.state.facet(noteContext);
  if (!ctx) return;
  const session = noteSessionOf(view);
  if (session) {
    pickAndInsertAttachments(session, 'image/*');
    return;
  }
  // A Markdown editor that is not a note's (a canvas card) inserts through its own context.
  const { from, to } = view.state.selection.main;
  void pickFiles({ accept: 'image/*', multiple: true }).then((files) => ctx.insertFiles(files, { from, to }, false));
}

/** A file type the `/` menu can create and embed (a view's `create`: drawing, spreadsheet, canvas). */
export interface EmbeddableKind {
  label: string;
  extension: string;
  initialContent(): string;
}

function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Asks for a name, creates a new file of `kind` where new notes go, and embeds it where the cursor
 * was (followed through edits made meanwhile, on this device or another).
 */
export async function createAndEmbed(view: EditorView, kind: EmbeddableKind): Promise<void> {
  const session = noteSessionOf(view);
  if (!session) return;
  const { from, to } = session.insertionRange();
  const tracked = session.trackRange(from, to);
  if (tracked === null) return;
  const suggested = `${capitalized(kind.label)} ${dayjs().format('YYYY-MM-DD HH.mm')}`;
  const name = await promptText({
    title: `New ${kind.label}`,
    label: 'Name',
    value: suggested,
    confirmLabel: 'Create and embed',
    validate: (v) => (v.trim() === '' ? 'A name is required' : validateNewName(`${v.trim()}.${kind.extension}`)),
  });
  if (name === null) {
    session.takeRange(tracked);
    return;
  }
  try {
    const content = kind.initialContent();
    const path = joinPath(newNoteFolder(session.path), `${name.trim()}.${kind.extension}`);
    const result = await api.createFile({ path, content, onConflict: 'rename' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, content);
    const range = session.takeRange(tracked);
    if (!range) return;
    const insert = '!' + linkTo(result.file.path, session.path);
    session.applyEdit({ from: range.from, to: range.to, insert }, { selection: { anchor: range.from + insert.length }, userEvent: 'input' });
  } catch (e) {
    session.takeRange(tracked);
    toastError(e);
  }
}
