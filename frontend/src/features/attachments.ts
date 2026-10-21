// Attachments (DESIGN §6.6 #10, §6.15): paste and drop into a note, the "Insert attachment…"
// picker through the app-level file input, and OS files dropped on an explorer folder with the
// pre-upload collision prompt.
import { api, type RawConflict } from '../api/endpoints';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { findFileIgnoreCase } from '../api/vaultTree';
import { newIdempotencyKey } from '../state/clientId';
import { chooseAction } from '../state/dialogs';
import { toast } from '../state/toasts';
import type { DocumentSession } from '../sync/DocumentSession';
import { applyAttachmentResult } from '../sync/applyEvents';
import { syncTarget } from '../sync/liveSync';
import { applyWriteResult } from '../sync/treePatch';
import { dayjs } from './dates';
import { extensionOf, joinPath, lastSegment } from './paths';
import { toastError } from './errors';
import { formatLimit, isLargeFile, largeFileLimit } from './largeFiles';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

/** Pasted files are named `Pasted image YYYYMMDDHHmmss.<ext>` in local time (Obsidian's convention). */
export function attachmentName(file: Pick<File, 'name' | 'type'>, pasted: boolean, now: Date = new Date()): string {
  if (!pasted && file.name) return file.name;
  const ext = MIME_EXTENSIONS[file.type] ?? (extensionOf(file.name) || 'bin');
  const label = file.type.startsWith('image/') ? 'Pasted image' : 'Pasted file';
  return `${label} ${dayjs(now).format('YYYYMMDDHHmmss')}.${ext}`;
}

/**
 * Uploads `files` for the note of `session` and inserts their embeds at `range` (the current
 * selection, which CodeMirror keeps after blur). While a file uploads, an "Uploading name…"
 * widget marks its place; it is never document text, so autosave, drafts and other devices never
 * see it, and a tab killed mid-upload leaves nothing behind (DESIGN §6.6 #10). Each embed
 * (`AttachmentResult.markdown`) goes in at the widget's mapped position, in the files' order;
 * a failed upload just removes its widget. Uploads in flight count as unsaved work.
 */
export async function insertAttachments(session: DocumentSession, files: readonly File[], range: { from: number; to: number }, pasted: boolean): Promise<void> {
  if (files.length === 0 || !session.isEditable()) return;
  const now = new Date();
  const userEvent = pasted ? 'input.paste' : 'input.drop';
  const uploads: Array<{ id: number; name: string; result: Promise<{ markdown: string } | { error: unknown }> }> = [];
  for (const file of files) {
    const name = attachmentName(file, pasted, now);
    // Only the first upload replaces the selection; the others start where it was.
    const id = session.beginUpload(uploads.length === 0 ? range : { from: range.from, to: range.from }, name, userEvent);
    if (id === null) break;
    const result = api.uploadAttachment(name, session.path, file, { idempotencyKey: newIdempotencyKey() }).then(
      (r) => {
        applyAttachmentResult(syncTarget, r);
        return { markdown: r.markdown };
      },
      (error: unknown) => ({ error }),
    );
    uploads.push({ id, name, result });
  }

  // Embeds go in in the files' order, each after the previous one.
  let inserted = false;
  for (const u of uploads) {
    const outcome = await u.result;
    if ('error' in outcome) {
      session.cancelUpload(u.id);
      toastError(outcome.error, u.name);
      continue;
    }
    if (session.finishUpload(u.id, (inserted ? '\n' : '') + outcome.markdown)) inserted = true;
    else toast(`Uploaded ${u.name}, but the note could not be edited to insert it`, { kind: 'error' });
  }
}

// ---------- the app-level file input (hosted by AppShell) ----------

type FilePicker = (opts: { accept?: string; multiple?: boolean }) => Promise<File[]>;

let picker: FilePicker | null = null;

export function setFilePicker(fn: FilePicker | null): void {
  picker = fn;
}

/**
 * Opens the system file picker. Call it inside the user's gesture; remember the insertion point
 * first, because the picker blurs the editor.
 */
export function pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return picker ? picker(opts) : Promise.resolve([]);
}

/** "Insert attachment…": picks files and inserts them where the cursor was. */
export function pickAndInsertAttachments(session: DocumentSession, accept?: string): void {
  const range = session.insertionRange();
  void pickFiles({ accept, multiple: true }).then((files) => insertAttachments(session, files, range, false));
}

// ---------- OS files dropped on an explorer folder ----------

/**
 * Uploads OS files into `folder` with `PUT /api/files/raw`. A name that already exists (ignoring
 * case) asks Replace (non-text files only), Keep both or Skip before anything is uploaded.
 */
export async function uploadToFolder(folder: string, files: readonly File[]): Promise<void> {
  const plan: Array<{ file: File; path: string; onConflict: RawConflict }> = [];
  for (const file of files) {
    const path = joinPath(folder, lastSegment(file.name));
    const existing = findFileIgnoreCase(currentTree(), path);
    if (!existing) {
      plan.push({ file, path, onConflict: 'fail' });
      continue;
    }
    const textual = existing.kind === 'note' || existing.kind === 'text';
    const limit = largeFileLimit();
    const note = textual
      ? ' Notes and text files cannot be replaced by an upload.'
      : limit !== null && isLargeFile(existing.size)
        ? ` It is larger than ${formatLimit(limit)}, so it is not in history: replacing it moves it to the trash.`
        : '';
    const choice = await chooseAction({
      title: 'File already exists',
      message: `“${existing.path}” already exists.${note}`,
      choices: [
        { id: 'skip', label: 'Skip' },
        { id: 'rename', label: 'Keep both', primary: textual },
        ...(textual ? [] : [{ id: 'overwrite' as const, label: 'Replace', primary: true, danger: true }]),
      ],
    });
    if (choice === null) return;
    if (choice === 'skip') continue;
    plan.push({ file, path: choice === 'overwrite' ? existing.path : path, onConflict: choice });
  }
  let uploaded = 0;
  for (const item of plan) {
    try {
      const result = await api.uploadRaw(item.path, item.file, item.onConflict, { idempotencyKey: newIdempotencyKey() });
      applyWriteResult(queryClient, result);
      uploaded++;
    } catch (e) {
      toastError(e, item.file.name);
    }
  }
  if (uploaded > 0) toast(`Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}${folder ? ` to ${folder}` : ''}`);
}
