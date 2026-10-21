// The canvas's name above the board: editing it renames the file (the extension stays). A canvas
// just created with "New canvas" continues here with the title typed while it was being created.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toastError } from '../../features/errors';
import { nameWithExtension, renameEntry, validateNewName } from '../../features/fileOps';
import { basenameOf, lastSegment } from '../../features/paths';
import { takeTitleHandoff } from '../../state/pendingNote';

export function CanvasTitle({ path, editable }: { path: string; editable: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const title = basenameOf(lastSegment(path));
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reverting = useRef(false);
  const value = draft ?? title;
  const error = draft !== null && draft.trim() !== title ? (draft.trim() === '' ? 'A name is required' : validateNewName(nameWithExtension(path, draft.trim(), 'file'))) : null;

  useLayoutEffect(() => {
    const handoff = takeTitleHandoff(path);
    const el = ref.current;
    if (handoff && el) {
      setDraft(handoff.title);
      el.focus();
      queueMicrotask(() => el.setSelectionRange(handoff.selectionStart, handoff.selectionEnd));
    }
  }, [path]);

  const commit = async () => {
    if (reverting.current) {
      reverting.current = false;
      setDraft(null);
      return;
    }
    const next = (draft ?? '').trim();
    if (draft === null || next === '' || next === title || error) {
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await renameEntry(path, next, 'file');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      setDraft(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (error) return;
      // On to the board, as Enter in a note's title moves on to its text.
      const board = e.currentTarget.closest('.canvas-view')?.querySelector<HTMLElement>('.canvas-stage');
      e.currentTarget.blur();
      board?.focus({ preventScroll: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      reverting.current = true;
      e.currentTarget.blur();
    }
  };

  return (
    <input
      ref={ref}
      className={`canvas-title${error ? ' is-invalid' : ''}`}
      value={value}
      size={Math.max(4, Math.min(40, value.length + 1))}
      readOnly={!editable || busy}
      aria-label="Canvas name"
      aria-invalid={!!error}
      title={error ?? undefined}
      spellCheck={false}
      enterKeyHint="done"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void commit()}
    />
  );
}
