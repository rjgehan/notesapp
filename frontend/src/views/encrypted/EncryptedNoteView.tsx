// The `.mdenc` view (ROADMAP item 27, DESIGN §6.33). The document session (autosave, drafts,
// offline copy, conflicts, live sync) only ever holds the Meld Encrypt JSON with its ciphertext:
// the decrypted text lives in a separate CodeMirror view that is never registered as the active
// editor (so no palette command, AI summary or voice note can read it) and is destroyed on lock.
// Edits are encrypted within ~100 ms and handed to the session as its serialized text.
import { EditorState } from '@codemirror/state';
import { EditorView, placeholder } from '@codemirror/view';
import { KeyRound, Lock, LockOpen, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SaveStatus } from '../../components/SaveStatus';
import { NO_RECOVERY } from '../../components/overlays/EncryptionDialogs';
import { plainTextExtensions } from '../../editor/editorSetup';
import { remoteTransaction } from '../../editor/remote';
import { markdownNoteLanguage } from '../../editor/language';
import { decryptPayload, type WriteKey } from '../../features/encryption/cipher';
import { createKey, lock, onLock, openCached, readPayload, unlock } from '../../features/encryption/keyring';
import { FormatError, parseEncryptedFile, saltId, type EncryptedFile, type Payload } from '../../features/encryption/meld';
import { decryptToMarkdown, ENCRYPTED_NOTE_WARNING, encryptedFileText } from '../../features/encryption/notes';
import { lastSegment } from '../../features/paths';
import { askPassphrase } from '../../state/dialogs';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import type { FileViewProps } from '../registry';
import { setActiveEncrypted, type EncryptedControls } from './active';

type Phase =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'locked'; hint: string; notice: string | null }
  | { kind: 'new' }
  | { kind: 'unlocked' };

interface Unlocked {
  write: WriteKey;
  hint: string;
  /** The text the editor starts from (later, the editor holds it). */
  text: string;
}

const ENCRYPT_DELAY_MS = 100;

function parse(text: string): EncryptedFile | string {
  try {
    return parseEncryptedFile(text);
  } catch (e) {
    return e instanceof FormatError ? e.message : 'This file cannot be read.';
  }
}

function payloadOf(file: EncryptedFile): Payload | string {
  return readPayload(file.encodedData, file.version === '2.0' ? 2 : 1);
}

export default function EncryptedNoteView({ path }: FileViewProps) {
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  const remoteCount = useSyncExternalStore(session.subscribe, session.getRemoteChangeCount);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const host = useRef<HTMLDivElement>(null);
  const unlocked = useRef<Unlocked | null>(null);
  const editor = useRef<EditorView | null>(null);
  /** The file text this view produced last (the session's serialized text). */
  const ownText = useRef<string | null>(null);
  const encryption = useRef({ seq: 0, dirty: false, timer: null as ReturnType<typeof setTimeout> | null, pending: Promise.resolve() });
  const name = lastSegment(path);
  const readOnly = !snapshot.loaded || snapshot.status === 'readonly' || snapshot.lossy;

  // ---------- encryption of edits ----------

  const encryptAndHand = useCallback(
    (u: Unlocked, text: string): Promise<void> => {
      const enc = encryption.current;
      const seq = ++enc.seq;
      const run = enc.pending.then(async () => {
        const fileText = await encryptedFileText(text, u.write, u.hint);
        if (seq !== enc.seq) return;
        ownText.current = fileText;
        enc.dirty = false;
        session.markDirty(() => ownText.current ?? fileText);
      });
      enc.pending = run.catch(() => undefined);
      return run;
    },
    [session],
  );

  const encryptNow = useCallback((): Promise<void> => {
    const enc = encryption.current;
    if (enc.timer) {
      clearTimeout(enc.timer);
      enc.timer = null;
    }
    const u = unlocked.current;
    const v = editor.current;
    if (!u || !v || !enc.dirty) return enc.pending;
    return encryptAndHand(u, v.state.doc.toString());
  }, [encryptAndHand]);

  const scheduleEncrypt = useCallback(() => {
    const enc = encryption.current;
    enc.dirty = true;
    if (enc.timer) return;
    enc.timer = setTimeout(() => {
      enc.timer = null;
      void encryptNow();
    }, ENCRYPT_DELAY_MS);
  }, [encryptNow]);

  /** Encrypts what is pending with the key held now, then forgets the plaintext and the key. */
  const teardown = useCallback(
    (next: Phase | null) => {
      const enc = encryption.current;
      if (enc.timer) clearTimeout(enc.timer);
      enc.timer = null;
      const u = unlocked.current;
      const v = editor.current;
      if (u && v && enc.dirty) {
        const text = v.state.doc.toString();
        void encryptAndHand(u, text).then(() => session.flush());
      }
      // The phase change unmounts the editor, which destroys its view (and the plaintext in it).
      editor.current = null;
      unlocked.current = null;
      if (next) setPhase(next);
    },
    [encryptAndHand, session],
  );

  const showUnlocked = useCallback((u: Unlocked) => {
    unlocked.current = u;
    setPhase({ kind: 'unlocked' });
  }, []);

  // ---------- reading the session's text (load, remote change, take theirs, restored draft) ----------

  useEffect(() => {
    if (!snapshot.loaded) return;
    const text = session.getText();
    if (text === ownText.current && unlocked.current) return;
    let cancelled = false;
    const file = parse(text);
    const payload = typeof file === 'string' || file.encodedData === '' ? null : payloadOf(file);
    void (async () => {
      // Decided after a microtask: the phase is state derived from the session, set from its events.
      await Promise.resolve();
      if (cancelled) return;
      if (typeof file === 'string' || typeof payload === 'string') {
        teardown({ kind: 'invalid', message: typeof file === 'string' ? file : (payload as string) });
        return;
      }
      if (payload === null) {
        if (!unlocked.current) setPhase({ kind: 'new' });
        return;
      }
      const u = unlocked.current;
      let opened: { text: string; write: WriteKey } | null = null;
      if (u && payload.version === 2 && saltId(payload.salt) === saltId(u.write.salt)) {
        const plain = await decryptPayload(payload, u.write.key);
        if (plain !== null) opened = { text: plain, write: u.write };
      }
      opened ??= await openCached(payload);
      if (cancelled) return;
      if (!opened) {
        teardown({ kind: 'locked', hint: file.hint, notice: u ? 'This note was encrypted again elsewhere with another passphrase. Unlock it with that one.' : null });
        return;
      }
      ownText.current = text;
      const v = editor.current;
      if (u && v) {
        // Another device's text (or Take theirs): into the open editor, outside its undo history.
        u.hint = file.hint;
        u.write = opened.write;
        const spec = remoteTransaction(v.state, opened.text);
        if (spec) v.dispatch(spec);
        return;
      }
      showUnlocked({ write: opened.write, hint: file.hint, text: opened.text });
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot.loaded, remoteCount, session, teardown, showUnlocked]);

  // ---------- the plaintext editor ----------

  useLayoutEffect(() => {
    if (phase.kind !== 'unlocked' || !host.current || !unlocked.current) return;
    const u = unlocked.current;
    const extensions = plainTextExtensions(
      {
        onLocalChange: scheduleEncrypt,
        onBlur: () => void encryptNow().then(() => session.flush()),
        save: () => void encryptNow().then(() => session.flush()),
        readOnly,
        // Browser spell checkers may send text to a cloud service: never for decrypted text.
        spellcheck: false,
        autocorrect: false,
      },
      markdownNoteLanguage(),
    );
    const view = new EditorView({
      state: EditorState.create({ doc: editor.current?.state.doc.toString() ?? u.text, extensions: [extensions, placeholder('Write here; it is encrypted before it leaves this page.')] }),
      parent: host.current,
    });
    editor.current = view;
    u.text = '';
    return () => {
      if (editor.current === view) {
        // Unmount or a read-only switch: keep the text for a rebuild, encrypted first if edited.
        u.text = view.state.doc.toString();
        void encryptNow().then(() => session.flush());
        editor.current = null;
      }
      view.destroy();
    };
  }, [phase.kind, readOnly, scheduleEncrypt, encryptNow, session]);

  // Lock (manual, idle, hidden page) and leaving the view.
  useEffect(
    () =>
      onLock(() => {
        if (unlocked.current) teardown({ kind: 'locked', hint: currentHint(session.getText()), notice: null });
      }),
    [teardown, session],
  );
  useEffect(
    () => () => {
      teardown(null);
    },
    [teardown],
  );

  // ---------- actions ----------

  const changePassphrase = useCallback(async () => {
    const u = unlocked.current;
    if (!u) return;
    await encryptNow();
    let made: { write: WriteKey; hint: string } | null = null;
    const ok = await askPassphrase({
      mode: 'create',
      title: 'Change passphrase',
      message: 'The note is encrypted again with the new passphrase. Its earlier versions in history keep the old one.',
      hint: u.hint,
      confirmLabel: 'Change',
      submit: async (passphrase, hint) => {
        made = { write: await createKey(passphrase), hint };
        return null;
      },
    });
    const next = made as { write: WriteKey; hint: string } | null;
    const current = unlocked.current;
    const v = editor.current;
    if (!ok || !next || current !== u || !v) return;
    u.write = next.write;
    u.hint = next.hint;
    await encryptAndHand(u, v.state.doc.toString());
    await session.flush();
  }, [encryptAndHand, encryptNow, session]);

  const removeEncryption = useCallback(async () => {
    const v = editor.current;
    if (!v) return;
    await encryptNow();
    await decryptToMarkdown(path, v.state.doc.toString());
  }, [encryptNow, path]);

  const setFirstPassphrase = useCallback(async () => {
    let made: { write: WriteKey; hint: string } | null = null;
    const ok = await askPassphrase({
      mode: 'create',
      title: 'Choose a passphrase',
      message: ENCRYPTED_NOTE_WARNING,
      submit: async (passphrase, hint) => {
        made = { write: await createKey(passphrase), hint };
        return null;
      },
    });
    const next = made as { write: WriteKey; hint: string } | null;
    if (!ok || !next) return;
    const u: Unlocked = { write: next.write, hint: next.hint, text: '' };
    await encryptAndHand(u, '');
    showUnlocked(u);
  }, [encryptAndHand, showUnlocked]);

  useEffect(() => {
    const controls: EncryptedControls = {
      unlocked: () => unlocked.current !== null,
      changePassphrase: () => void changePassphrase(),
      removeEncryption: () => void removeEncryption(),
    };
    return setActiveEncrypted(path, controls);
  }, [path, changePassphrase, removeEncryption]);

  // ---------- render ----------

  return (
    <div className="markdown-view is-readable encrypted-view">
      <header className="file-view-header">
        <h1 className="file-view-title">{name.replace(/\.mdenc$/i, '')}</h1>
        <div className="encrypted-actions">
          <SaveStatus snapshot={snapshot} />
          {phase.kind === 'unlocked' && (
            <>
              <button type="button" className="icon-button" title="Change passphrase" aria-label="Change passphrase" onClick={() => void changePassphrase()} disabled={readOnly}>
                <KeyRound size={16} />
              </button>
              <button type="button" className="button button-small" onClick={() => lock()} title="Lock every encrypted note now">
                <Lock size={14} aria-hidden /> Lock
              </button>
            </>
          )}
        </div>
      </header>
      {phase.kind === 'loading' || (!snapshot.loaded && snapshot.status === 'loading') ? (
        <div className="view-loading" aria-busy="true">
          <div className="skeleton-line" />
        </div>
      ) : !snapshot.loaded ? (
        <div className="error-panel" role="alert">
          <p className="error-panel-title">This note could not be opened.</p>
          <p className="error-panel-detail">{snapshot.error}</p>
          <button type="button" className="button" onClick={() => void session.reload()}>
            Try again
          </button>
        </div>
      ) : phase.kind === 'invalid' ? (
        <div className="error-panel" role="alert">
          <p className="error-panel-title">This encrypted note cannot be read.</p>
          <p className="error-panel-detail">{phase.message}</p>
        </div>
      ) : phase.kind === 'locked' ? (
        <UnlockForm
          hint={phase.hint}
          notice={phase.notice}
          onUnlock={async (passphrase) => {
            const file = parse(session.getText());
            if (typeof file === 'string') return file;
            const payload = payloadOf(file);
            if (typeof payload === 'string') return payload;
            const opened = await unlock(passphrase, payload);
            if (!opened) return 'Wrong passphrase.';
            ownText.current = session.getText();
            showUnlocked({ write: opened.write, hint: file.hint, text: opened.text });
            return null;
          }}
        />
      ) : phase.kind === 'new' ? (
        <div className="encrypted-locked">
          <LockOpen size={32} aria-hidden />
          <p>This encrypted note has no passphrase yet.</p>
          <button type="button" className="button button-primary" onClick={() => void setFirstPassphrase()} disabled={readOnly}>
            Choose a passphrase…
          </button>
        </div>
      ) : (
        <div ref={host} className="note-editor encrypted-editor" />
      )}
    </div>
  );
}

function currentHint(text: string): string {
  const file = parse(text);
  return typeof file === 'string' ? '' : file.hint;
}

function UnlockForm({ hint, notice, onUnlock }: { hint: string; notice: string | null; onUnlock(passphrase: string): Promise<string | null> }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  return (
    <form
      className="encrypted-locked"
      onSubmit={(e) => {
        e.preventDefault();
        if (passphrase === '' || busy) return;
        setBusy(true);
        setError(null);
        void onUnlock(passphrase)
          .catch((err: unknown) => (err instanceof Error ? err.message : 'Decryption failed.'))
          .then((result) => {
            setBusy(false);
            if (result === null) return;
            setError(result === 'Wrong passphrase.' ? 'Wrong passphrase. Check the hint, Caps Lock and the keyboard layout, then try again.' : result);
            setPassphrase('');
            input.current?.focus();
          });
      }}
    >
      <Lock size={32} aria-hidden />
      <h2 className="encrypted-locked-title">This note is encrypted</h2>
      {notice && <p className="field-warning">{notice}</p>}
      {hint && (
        <p className="passphrase-hint">
          Hint: <span>{hint}</span>
        </p>
      )}
      <label className="field encrypted-unlock-field">
        <span className="field-label">Passphrase</span>
        <input
          ref={input}
          className="text-input"
          type="password"
          value={passphrase}
          disabled={busy}
          aria-invalid={!!error}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button button-primary" disabled={busy || passphrase === ''}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <p className="encrypted-footnote">
        <ShieldAlert size={14} aria-hidden /> Decrypted only in this browser, until it locks. {NO_RECOVERY}
      </p>
    </form>
  );
}
