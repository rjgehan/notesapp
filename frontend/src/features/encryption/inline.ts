// Inline encrypted sections in Markdown notes (ROADMAP item 27, DESIGN §6.33): open one (its text
// is decrypted into a dialog, never into the note), insert a new one, encrypt a selection. The
// note's buffer, drafts, offline copy, history and the server only ever hold the ciphertext.
import { confirmAction, askPassphrase, editSecret } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import type { DocumentSession } from '../../sync/DocumentSession';
import { encryptText, type WriteKey } from './cipher';
import { createKey, openCached, readPayload, unlock, type Opened } from './keyring';
import { findSections, formatSection, type InlineSection, type Payload } from './meld';

const UNSUPPORTED_V0 = 'This section uses the first Meld Encrypt format, which this app cannot read. Open it once in Obsidian to upgrade it.';

/** Where the section is now: the occurrence of its text closest to where it was. */
function locate(text: string, section: Pick<InlineSection, 'text' | 'from'>): { from: number; to: number } | null {
  let best = -1;
  for (let i = text.indexOf(section.text); i >= 0; i = text.indexOf(section.text, i + 1)) {
    if (best < 0 || Math.abs(i - section.from) < Math.abs(best - section.from)) best = i;
  }
  return best < 0 ? null : { from: best, to: best + section.text.length };
}

function payloadsOf(text: string, except: InlineSection): Payload[] {
  const out: Payload[] = [];
  for (const s of findSections(text)) {
    if (s.from === except.from || s.version === 0) continue;
    const p = readPayload(s.base64, s.version);
    if (typeof p !== 'string') out.push(p);
  }
  return out;
}

/** Opens with a cached key, else asks for the passphrase (wrong ones are reported in the dialog). */
async function openPayload(payload: Payload, hint: string, title: string, others: () => Payload[]): Promise<Opened | null> {
  const cached = await openCached(payload);
  if (cached) return cached;
  let opened: Opened | null = null;
  const ok = await askPassphrase({
    mode: 'unlock',
    title,
    hint,
    submit: async (passphrase) => {
      opened = await unlock(passphrase, payload, others());
      return opened ? null : 'Wrong passphrase. Nothing was changed; try again.';
    },
  });
  return ok ? opened : null;
}

/** Opens the section in the secret dialog; Save encrypts it again in place. */
export async function openSection(session: DocumentSession, section: InlineSection): Promise<void> {
  if (section.version === 0) {
    toast(UNSUPPORTED_V0);
    return;
  }
  const payload = readPayload(section.base64, section.version);
  if (typeof payload === 'string') {
    toast(payload);
    return;
  }
  const opened = await openPayload(payload, section.hint, 'Unlock encrypted text', () => payloadsOf(session.getText(), section));
  if (!opened) return;
  // The key stays referenced here until the dialog closes, even if the keyring locks meanwhile.
  const write: WriteKey = opened.write;
  const result = await editSecret({ title: 'Encrypted text', text: opened.text, hint: section.hint });
  if (!result) return;
  if (!session.isEditable()) {
    toast('This note cannot be edited right now; the change was not saved.');
    return;
  }
  if (result.action === 'decrypt') {
    const ok = await confirmAction({
      title: 'Remove encryption?',
      message:
        'The text will be written into the note in plain form: it is then saved to the server, searchable, sent to Ask your vault when you use it, and kept in the note’s version history for good.',
      confirmLabel: 'Remove encryption',
      danger: true,
    });
    if (!ok) return;
    replaceSection(session, section, result.text);
    return;
  }
  const replacement = formatSection(await encryptText(result.text, write), result.hint, section.visible);
  replaceSection(session, section, replacement);
}

function replaceSection(session: DocumentSession, section: InlineSection, insert: string): void {
  const at = locate(session.getText(), section);
  if (at) {
    session.applyEdit({ from: at.from, to: at.to, insert });
    return;
  }
  // The section changed or moved while it was open (another device): keep the edit as a new one.
  const pos = Math.min(section.from, session.getText().length);
  session.applyEdit({ from: pos, insert });
  toast('The encrypted text changed elsewhere while it was open; your version was inserted next to it.');
}

/** Asks for a new passphrase (twice, with the no-recovery warning) and keeps its key for the session. */
async function newKey(title: string, message: string): Promise<{ write: WriteKey; hint: string } | null> {
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

/** Asks for a passphrase, then the secret, and inserts it encrypted at `range`. */
export async function insertSection(session: DocumentSession, range: { from: number; to: number }): Promise<void> {
  const key = await newKey('New encrypted text', 'Choose the passphrase for this text. You can use the same one for several sections.');
  if (!key) return;
  const result = await editSecret({ title: 'New encrypted text', text: '', hint: key.hint, isNew: true });
  if (!result || result.action !== 'save') return;
  const section = formatSection(await encryptText(result.text, key.write), result.hint);
  if (!session.isEditable()) return;
  const len = session.getText().length;
  session.applyEdit({ from: Math.min(range.from, len), to: Math.min(range.to, len), insert: section }, { selection: { anchor: Math.min(range.from, len) + section.length } });
}

/** Encrypts the selected text in place. Its plain form may already be in drafts and history. */
export async function encryptSelection(session: DocumentSession, range: { from: number; to: number }): Promise<void> {
  const original = session.getText().slice(range.from, range.to);
  if (original.trim() === '') {
    toast('Select the text to encrypt first');
    return;
  }
  if (findSections(original).length > 0) {
    toast('The selection already contains encrypted text');
    return;
  }
  const key = await newKey(
    'Encrypt selection',
    'If this text was already saved, its plain form stays in the note’s version history. For new secrets, use “Insert encrypted text” instead.',
  );
  if (!key) return;
  const section = formatSection(await encryptText(original, key.write), key.hint);
  if (!session.isEditable()) return;
  // Only if the selection is still what was encrypted.
  if (session.getText().slice(range.from, range.to) !== original) {
    toast('The text changed meanwhile; nothing was encrypted.');
    return;
  }
  session.applyEdit({ from: range.from, to: range.to, insert: section });
}

/** The section's text as the reading view hands it over (data-section), at its first occurrence. */
export function sectionFromText(text: string, sectionText: string): InlineSection | null {
  return findSections(text).find((s) => s.text === sectionText) ?? null;
}
