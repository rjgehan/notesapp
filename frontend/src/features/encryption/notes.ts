// Whole encrypted notes (`.mdenc`, DESIGN §6.33): create one, encrypt a Markdown note into one,
// and turn one back into a Markdown note. The passphrase dialog never hands the passphrase out;
// only keys (non-extractable) and ciphertext leave it.
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { noteCache } from '../../offline/offlineStore';
import { askPassphrase, confirmAction } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { documents, draftStore } from '../../sync/instance';
import { applyWriteResult } from '../../sync/treePatch';
import { toastError } from '../errors';
import { createNote, moveRequest, newNoteFolder } from '../fileOps';
import { activePath, navigateTo, openPath } from '../navigation';
import { folderOf, joinPath, lastSegment } from '../paths';
import { encryptText, type WriteKey } from './cipher';
import { createKey } from './keyring';
import { MDENC_EXTENSION, serializeEncryptedFile } from './meld';

export const ENCRYPTED_NOTE_WARNING =
  'Encrypted notes are not searchable, have no backlinks or tags, and are never sent to Ask your vault. The server, git history, backups and this browser’s offline copies only ever hold the ciphertext.';

/** The `.mdenc` file text for `plaintext`. */
export async function encryptedFileText(plaintext: string, write: WriteKey, hint: string): Promise<string> {
  return serializeEncryptedFile({ version: '2.0', hint, encodedData: await encryptText(plaintext, write) });
}

async function chooseKey(title: string, message: string): Promise<{ write: WriteKey; hint: string } | null> {
  let made: { write: WriteKey; hint: string } | null = null;
  const ok = await askPassphrase({
    mode: 'create',
    title,
    message,
    submit: async (passphrase, hint) => {
      made = { write: await createKey(passphrase), hint };
      return null;
    },
  });
  return ok ? made : null;
}

/** "New encrypted note": the passphrase first, then an ordinary new-file flow with the ciphertext of an empty note. */
export async function createEncryptedNote(fromPath: string | null): Promise<void> {
  const key = await chooseKey('New encrypted note', ENCRYPTED_NOTE_WARNING);
  if (!key) return;
  const content = await encryptedFileText('', key.write, key.hint);
  createNote(newNoteFolder(fromPath), content, MDENC_EXTENSION, 'encrypted note');
}

/** Drops this browser's plain copies of a note: its drafts and its offline copy. */
async function forgetLocalCopies(path: string): Promise<void> {
  try {
    for (const d of await draftStore.listForPath(path)) await draftStore.remove(d.path, d.clientId);
  } catch {
    // No IndexedDB: nothing was stored.
  }
  await noteCache.remove(path).catch(() => undefined);
}

/**
 * Encrypts a Markdown note into `<name>.mdenc`: a move (links follow) and then the ciphertext.
 * The note's earlier, plain versions stay in its git history; the dialog says so.
 */
export async function encryptExistingNote(path: string): Promise<void> {
  const ok = await confirmAction({
    title: 'Encrypt this note?',
    message:
      'The note becomes an encrypted .mdenc note, and links to it are updated. Its earlier versions stay readable in version history (git) and in any backup made before now; only new text is protected. ' +
      ENCRYPTED_NOTE_WARNING,
    confirmLabel: 'Choose a passphrase…',
  });
  if (!ok) return;
  const key = await chooseKey('Encrypt this note', 'This passphrase will be needed to open the note on every device.');
  if (!key) return;
  const session = documents.get(path);
  try {
    if (session) await session.flush();
    const file = await api.readFile(path);
    const content = await encryptedFileText(file.content, key.write, key.hint);
    const to = joinPath(folderOf(path), lastSegment(path).replace(/\.md$/i, '') + '.' + MDENC_EXTENSION);
    // Leave the note first: the editor must not follow it to the new name with its plain text.
    if (activePath() === path) navigateTo('/', { replace: true });
    const moved = await moveRequest(path, to, true);
    const target = await api.readFile(moved.to);
    const result = await api.saveFile(moved.to, { content, baseVersion: target.version, flushHistory: true });
    applyWriteResult(queryClient, result, content);
    await forgetLocalCopies(path);
    await forgetLocalCopies(moved.to);
    toast('Note encrypted. Older plain versions remain in its version history.');
    openPath(moved.to);
  } catch (e) {
    toastError(e);
  }
}

/** Writes a decrypted `.mdenc` note back as plain Markdown (`<name>.md`), after a warning. */
export async function decryptToMarkdown(path: string, plaintext: string): Promise<boolean> {
  const ok = await confirmAction({
    title: 'Remove encryption?',
    message:
      'The note is written back as a plain Markdown note: the server, search, backlinks and Ask your vault can read it, and its plain text is kept in version history for good.',
    confirmLabel: 'Remove encryption',
    danger: true,
  });
  if (!ok) return false;
  try {
    const session = documents.get(path);
    if (session) await session.flush();
    const to = joinPath(folderOf(path), lastSegment(path).replace(/\.mdenc$/i, '') + '.md');
    if (activePath() === path) navigateTo('/', { replace: true });
    const moved = await moveRequest(path, to, true);
    const target = await api.readFile(moved.to);
    const result = await api.saveFile(moved.to, { content: plaintext, baseVersion: target.version, flushHistory: true });
    applyWriteResult(queryClient, result, plaintext);
    openPath(moved.to);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}
