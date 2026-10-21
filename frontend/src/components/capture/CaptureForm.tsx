// The quick-capture form (DESIGN §6.22), shared by the capture dialog (palette, Mod-Shift-Space,
// the phone's "+") and the capture page (/capture: the share target, home-screen shortcut and the
// desktop app's capture window). The text field takes the focus at once, inside the opening tap,
// so iOS opens the keyboard.
import { CalendarDays, Image as ImageIcon, ImagePlus, Inbox, Link2, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CaptureTarget } from '../../api/types';
import { hasContent, lastTarget, type CaptureInput } from '../../features/capture';
import { submitCapture, type CaptureOutcome } from '../../features/captureSync';
import { formatBytes } from '../../features/format';
import { keyLabel, modKey } from '../../features/platform';
import { useUi } from '../../state/ui';
import '../../styles/capture.css';

export interface CaptureFormProps {
  initial?: Partial<Pick<CaptureInput, 'text' | 'url' | 'title' | 'target'>>;
  initialFiles?: File[];
  /** The capture is stored (sent, or queued while offline). */
  onDone(outcome: CaptureOutcome, input: CaptureInput): void;
  onCancel?(): void;
  autoFocus?: boolean;
}

export function CaptureForm({ initial, initialFiles = [], onDone, onCancel, autoFocus = true }: CaptureFormProps) {
  const [text, setText] = useState(initial?.text ?? '');
  const [url, setUrl] = useState<string | null>(initial?.url ?? null);
  const [title, setTitle] = useState<string | null>(initial?.title ?? null);
  const [target, setTarget] = useState<CaptureTarget>(initial?.target ?? lastTarget());
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = useUi((s) => s.connection === 'offline');
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const el = field.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const ready = hasContent({ text, url }, files.length) && !busy;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const input: CaptureInput = { text, url, title, target };
    try {
      const outcome = await submitCapture(input, files);
      if (outcome.status === 'failed') {
        setError(outcome.error);
        return;
      }
      onDone(outcome, input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && modKey(e)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="capture-form" onSubmit={(e) => void submit(e)}>
      <div className="capture-head">
        <h2 className="dialog-title">Quick capture</h2>
        <div className="capture-target" role="group" aria-label="Capture to">
          <button type="button" aria-pressed={target === 'inbox'} className={target === 'inbox' ? 'is-active' : ''} onClick={() => setTarget('inbox')}>
            <Inbox size={14} aria-hidden /> Inbox
          </button>
          <button type="button" aria-pressed={target === 'daily'} className={target === 'daily' ? 'is-active' : ''} onClick={() => setTarget('daily')}>
            <CalendarDays size={14} aria-hidden /> Today
          </button>
        </div>
      </div>
      <textarea
        ref={field}
        className="text-input capture-text"
        aria-label="Capture text"
        placeholder="A thought, a task, a link…"
        value={text}
        rows={5}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        autoCapitalize="sentences"
        enterKeyHint="enter"
      />
      {(url || files.length > 0) && (
        <ul className="capture-chips">
          {url && (
            <li className="capture-chip">
              <Link2 size={14} aria-hidden />
              <span className="capture-chip-text" title={url}>
                {title || url}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove the link"
                onClick={() => {
                  setUrl(null);
                  setTitle(null);
                }}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          )}
          {files.map((f, i) => (
            <li key={`${f.name}:${i}`} className="capture-chip">
              <ImageIcon size={14} aria-hidden />
              <span className="capture-chip-text">
                {f.name || 'Image'} <span className="muted">{formatBytes(f.size)}</span>
              </span>
              <button type="button" className="icon-button" aria-label={`Remove ${f.name || 'the image'}`} onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}>
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {offline && <p className="field-warning">Offline: the capture is kept on this device and added when the connection returns.</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions capture-actions">
        <button type="button" className="button" onClick={() => picker.current?.click()}>
          <ImagePlus size={15} aria-hidden /> Photo
        </button>
        <span className="capture-spacer" />
        {onCancel && (
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="button button-primary" disabled={!ready} title={`Save (${keyLabel('Mod-Enter')})`}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = '';
          if (picked.length > 0) setFiles((list) => [...list, ...picked]);
        }}
      />
    </form>
  );
}
