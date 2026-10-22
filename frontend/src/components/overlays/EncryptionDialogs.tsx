// Passphrase and secret-text dialogs for encrypted notes and sections (DESIGN §6.33). Inputs are
// never autocompleted, autocorrected or spell-checked: browser spell checkers can send text to
// a cloud service, and a password manager must not offer to save a note's passphrase as a login.
import { KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { onLock } from '../../features/encryption/keyring';
import { validHint } from '../../features/encryption/meld';
import { passphraseAdvice, MIN_PASSPHRASE_LENGTH } from '../../features/encryption/strength';
import type { PassphraseRequest, SecretRequest } from '../../state/dialogs';
import { Modal } from './Modal';

const SECRET_INPUT = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false } as const;

export const NO_RECOVERY =
  'There is no way to recover this text without the passphrase: it is not stored anywhere, not on the server, not in this browser, and nobody (not even the server’s owner) can reset it.';

export function PassphraseDialog({ request }: { request: PassphraseRequest }) {
  const create = request.mode === 'create';
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [hint, setHint] = useState(create ? (request.hint ?? '') : '');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const warningId = useId();

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  const hintError = create ? validHint(hint) : null;
  const tooShort = create && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = create && repeat !== '' && repeat !== passphrase;
  const advice = create && passphrase !== '' ? passphraseAdvice(passphrase) : null;
  const ready = passphrase !== '' && (!create || (!tooShort && repeat === passphrase && !hintError && understood));

  const submit = async () => {
    setTouched(true);
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    let result: string | null;
    try {
      result = await request.submit(passphrase, hint.trim());
    } catch (e) {
      result = e instanceof Error ? e.message : 'Encryption failed.';
    }
    setBusy(false);
    if (result === null) {
      request.resolve(true);
      return;
    }
    setError(result);
    if (!create) {
      // A wrong passphrase: select it, ready to be typed again.
      requestAnimationFrame(() => input.current?.select());
    }
  };

  const shownError = error ?? (touched && create ? (tooShort ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` : mismatch ? 'The passphrases do not match.' : hintError) : null);

  return (
    <Modal label={request.title} onClose={() => !busy && request.resolve(false)} dismissible={!busy} describedBy={shownError ? errorId : create ? warningId : undefined}>
      <form
        className="dialog passphrase-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="dialog-title">
          {create ? <KeyRound size={18} aria-hidden /> : <Lock size={18} aria-hidden />}
          {request.title}
        </h2>
        {request.message && <p className="dialog-message">{request.message}</p>}
        {!create && request.hint && (
          <p className="dialog-message passphrase-hint">
            Hint: <span>{request.hint}</span>
          </p>
        )}
        <label className="field">
          <span className="field-label">Passphrase</span>
          <input
            ref={input}
            className="text-input"
            type="password"
            value={passphrase}
            disabled={busy}
            aria-invalid={!!error || (touched && tooShort)}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setError(null);
            }}
            {...SECRET_INPUT}
            enterKeyHint={create ? 'next' : 'done'}
          />
        </label>
        {create && (
          <>
            {advice && <p className="field-warning passphrase-advice">{advice}</p>}
            <label className="field">
              <span className="field-label">Repeat the passphrase</span>
              <input
                className="text-input"
                type="password"
                value={repeat}
                disabled={busy}
                aria-invalid={mismatch}
                onChange={(e) => setRepeat(e.target.value)}
                {...SECRET_INPUT}
                enterKeyHint="next"
              />
            </label>
            <label className="field">
              <span className="field-label">Hint (optional, stored unencrypted next to the text)</span>
              <input className="text-input" type="text" value={hint} disabled={busy} aria-invalid={!!hintError} onChange={(e) => setHint(e.target.value)} {...SECRET_INPUT} enterKeyHint="next" />
            </label>
            <div className="encryption-warning" id={warningId}>
              <ShieldAlert size={18} aria-hidden />
              <p>
                <strong>If you forget this passphrase, the text is gone for good.</strong> {NO_RECOVERY}
              </p>
            </div>
            <label className="checkbox-field">
              <input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>I understand that a forgotten passphrase cannot be recovered</span>
            </label>
          </>
        )}
        {shownError && (
          <p id={errorId} className="field-error" role="alert">
            {shownError}
          </p>
        )}
        {busy && (
          <p className="dialog-message" role="status">
            {create ? 'Encrypting…' : 'Checking the passphrase…'}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={() => request.resolve(false)}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!ready || busy}>
            {request.confirmLabel ?? (create ? 'Encrypt' : 'Unlock')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SecretDialog({ request }: { request: SecretRequest }) {
  const [text, setText] = useState(request.text);
  const [hint, setHint] = useState(request.hint);
  const area = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ text, hint, changed: false });
  const hintError = validHint(hint);
  const changed = text !== request.text || hint !== request.hint;

  useLayoutEffect(() => {
    latest.current = { text, hint, changed };
  });

  useLayoutEffect(() => {
    area.current?.focus();
  }, []);

  // A lock while the dialog is open keeps what was typed (encrypted with the key the caller
  // holds) and closes it: no plaintext stays on screen.
  useEffect(
    () =>
      onLock(() => {
        const { text: t, hint: h, changed: c } = latest.current;
        request.resolve(c && !validHint(h) ? { action: 'save', text: t, hint: h.trim() } : null);
      }),
    [request],
  );

  const save = () => {
    if (hintError) return;
    request.resolve(changed || request.isNew ? { action: 'save', text, hint: hint.trim() } : null);
  };

  return (
    <Modal label={request.title} onClose={() => request.resolve(null)} variant="wide">
      <form
        className="dialog secret-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2 className="dialog-title">
          <Lock size={18} aria-hidden />
          {request.title}
        </h2>
        <textarea
          ref={area}
          className="text-input secret-text"
          rows={8}
          value={text}
          aria-label="Encrypted text"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          {...SECRET_INPUT}
        />
        <label className="field">
          <span className="field-label">Hint (stored unencrypted)</span>
          <input className="text-input" type="text" value={hint} aria-invalid={!!hintError} onChange={(e) => setHint(e.target.value)} {...SECRET_INPUT} />
        </label>
        {hintError && (
          <p className="field-error" role="alert">
            {hintError}
          </p>
        )}
        <p className="dialog-message">This text is only decrypted here, in this browser. Save encrypts it again; nothing in plain form reaches the note.</p>
        <div className="dialog-actions dialog-actions-wrap">
          {!request.isNew && (
            <button type="button" className="button button-danger secret-decrypt" onClick={() => request.resolve({ action: 'decrypt', text })}>
              Remove encryption…
            </button>
          )}
          <span className="dialog-actions-spacer" />
          <button type="button" className="button" onClick={() => request.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!!hintError}>
            {request.isNew ? 'Encrypt and insert' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
