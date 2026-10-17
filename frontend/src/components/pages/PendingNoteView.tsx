// The optimistic new-note view (DESIGN §6.15): shown at once by the tap on "New note", with its
// title focused synchronously (so iOS opens the keyboard) while the note is created.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useVaultSettings } from '../../api/hooks';
import { autoGrow, useAutoGrow } from '../autoGrow';
import { validateNewName } from '../../features/fileOps';
import { updatePendingSelection, updatePendingTitle, type PendingNote } from '../../state/pendingNote';

export function PendingNoteView({ pending }: { pending: PendingNote }) {
  const settings = useVaultSettings();
  const input = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(pending.title);
  useAutoGrow(input);
  const error = title.trim() === '' ? null : validateNewName(title.trim() + '.md');

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    if (!error) updatePendingTitle(pending.id, title, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className={`markdown-view${settings.editor.readableLineLength ? ' is-readable' : ''}`} aria-busy="true">
      <header className="note-header">
        <div className="inline-title-wrap">
          <h1 className="inline-title">
            <textarea
              ref={input}
              className="inline-title-input"
              rows={1}
              value={title}
              aria-label="Note title"
              aria-invalid={!!error}
              spellCheck={false}
              autoCapitalize="sentences"
              enterKeyHint="done"
              readOnly={pending.committed}
              onChange={(e) => {
                setTitle(e.target.value);
                autoGrow(e.target);
                updatePendingTitle(pending.id, e.target.value, false);
              }}
              onSelect={(e) => updatePendingSelection(pending.id, e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
              onKeyDown={onKeyDown}
              onBlur={commit}
            />
          </h1>
          {error && (
            <p className="field-error inline-title-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </header>
      <p className="pending-note-hint muted">{pending.committed ? 'Creating the note…' : 'Name the new note, then start writing.'}</p>
    </div>
  );
}
