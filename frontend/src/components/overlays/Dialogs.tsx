// PromptDialog, ConfirmDialog and the choice dialog, rendered from the dialog stack (eager).
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useDialogs, type ChoiceRequest, type ConfirmRequest, type PromptRequest } from '../../state/dialogs';
import { Modal } from './Modal';

function PromptDialog({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.value);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const error = request.validate ? request.validate(value) : null;

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const [start, end] = request.selection ?? [0, request.value.length];
    el.setSelectionRange(start, end);
  }, [request]);

  const submit = () => {
    setTouched(true);
    if (error || value.trim() === '') return;
    request.resolve(value);
  };

  return (
    <Modal label={request.title} onClose={() => request.resolve(null)} describedBy={error && touched ? errorId : undefined}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="dialog-title">{request.title}</h2>
        <label className="field">
          <span className="field-label">{request.label}</span>
          <input
            ref={input}
            className="text-input"
            value={value}
            placeholder={request.placeholder}
            aria-invalid={!!error && (touched || value !== request.value)}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            autoComplete="off"
            autoCapitalize="sentences"
            spellCheck={false}
            enterKeyHint="done"
          />
        </label>
        {error && (touched || value !== request.value) && (
          <p id={errorId} className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => request.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!!error || value.trim() === ''}>
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const confirm = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  useLayoutEffect(() => {
    confirm.current?.focus();
  }, []);
  return (
    <Modal label={request.title} onClose={() => request.resolve(false)} describedBy={messageId}>
      <div className="dialog">
        <h2 className="dialog-title">{request.title}</h2>
        <p id={messageId} className="dialog-message">
          {request.message}
        </p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => request.resolve(false)}>
            Cancel
          </button>
          <button ref={confirm} type="button" className={`button ${request.danger ? 'button-danger' : 'button-primary'}`} onClick={() => request.resolve(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChoiceDialog({ request }: { request: ChoiceRequest }) {
  const first = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  useLayoutEffect(() => {
    first.current?.focus();
  }, []);
  const primaryIndex = Math.max(0, request.choices.findIndex((c) => c.primary));
  return (
    <Modal label={request.title} onClose={() => request.resolve(null)} describedBy={messageId}>
      <div className="dialog">
        <h2 className="dialog-title">{request.title}</h2>
        <p id={messageId} className="dialog-message">
          {request.message}
        </p>
        <div className="dialog-actions dialog-actions-wrap">
          <button type="button" className="button" onClick={() => request.resolve(null)}>
            Cancel
          </button>
          {request.choices.map((c, i) => (
            <button
              key={c.id}
              ref={i === primaryIndex ? first : undefined}
              type="button"
              className={`button${c.primary ? ' button-primary' : ''}${c.danger ? ' button-danger' : ''}`}
              onClick={() => request.resolve(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((d) =>
        d.kind === 'prompt' ? (
          <PromptDialog key={d.id} request={d} />
        ) : d.kind === 'confirm' ? (
          <ConfirmDialog key={d.id} request={d} />
        ) : (
          <ChoiceDialog key={d.id} request={d} />
        ),
      )}
    </>
  );
}
