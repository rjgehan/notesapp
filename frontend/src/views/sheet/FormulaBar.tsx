// The formula bar (DESIGN §6.21.5): the name box (the selection's reference; type a cell, a range or
// a named range to go there) and the active cell's formula or value. Enter commits and moves
// down, Tab right (Shift the other way), Esc reverts; leaving the field commits. On a phone this
// is where cells are edited, at a 16 px font so iOS does not zoom.
import { SquareFunction } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import type { CellAt } from './gridModel';

export type Move = 'down' | 'up' | 'right' | 'left' | 'none';

/** The cell an edit started on, which a commit writes to whatever is selected by then. */
export type EditTarget = CellAt & { sheet: string };

export interface FormulaBarHandle {
  /** Starts editing `target` (inside the user's gesture, so iOS opens the keyboard), optionally replacing its text. */
  edit(target: EditTarget, text: string, initial?: string): void;
  isEditing(): boolean;
  /** The field, while it edits a cell (pointing at cells inserts references into it). */
  editingInput(): HTMLInputElement | null;
}

interface Props {
  /** The selection's reference: `B3`, `A1:C4`. */
  label: string;
  /** The active cell (of sheet `sheet`) and what the bar shows for it while not editing. */
  active: CellAt;
  sheet: string;
  text: string;
  editable: boolean;
  /** On touch devices Enter moves on to the next cell with the keyboard still up. */
  touch: boolean;
  /** The engine's explanation of an error result in the active cell. */
  error: string | null;
  onCommit(target: EditTarget, text: string, move: Move): void;
  /** Editing ended without a commit (Esc): the grid takes the focus back. */
  onCancel(): void;
  /** What was typed into the name box; false when it names nothing. */
  onGoTo(text: string): boolean;
}

export const FormulaBar = forwardRef<FormulaBarHandle, Props>(function FormulaBar({ label, active, sheet, text, editable, touch, error, onCommit, onCancel, onGoTo }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ target: EditTarget; value: string } | null>(null);
  // Kept in step by begin() and commit(): handlers read it before React re-renders.
  const draftRef = useRef(draft);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [nameInvalid, setNameInvalid] = useState(false);

  const begin = (target: EditTarget, value: string) => {
    const next = { target, value };
    draftRef.current = next;
    setDraft(next);
  };

  useImperativeHandle(ref, () => ({
    edit(target, current, initial) {
      begin(target, initial ?? current);
      const el = input.current;
      if (!el) return;
      // Synchronously, inside the gesture: iOS opens the keyboard only then.
      el.value = initial ?? current;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    },
    isEditing: () => draftRef.current !== null,
    editingInput: () => (draftRef.current !== null ? input.current : null),
  }));

  const commit = (move: Move) => {
    const d = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (d && (d.value !== text || move !== 'none' || d.target.col !== active.col || d.target.row !== active.row || d.target.sheet !== sheet)) onCommit(d.target, d.value, move);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.shiftKey ? 'up' : 'down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit(e.shiftKey ? 'left' : 'right');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draftRef.current = null;
      setDraft(null);
      onCancel();
    }
  };

  const goTo = () => {
    const value = nameDraft;
    if (value === null || value.trim() === '' || value === label) {
      setNameDraft(null);
      onCancel();
      return;
    }
    if (onGoTo(value)) {
      setNameDraft(null);
      setNameInvalid(false);
    } else setNameInvalid(true);
  };

  const shown = draft ? draft.value : text;
  return (
    <div className="sheet-formula-bar" role="group" aria-label="Formula bar">
      <input
        className="sheet-name-box"
        aria-label="Cell reference"
        title="Go to a cell, a range or a named range"
        aria-invalid={nameInvalid}
        value={nameDraft ?? label}
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        enterKeyHint="go"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setNameDraft(e.target.value);
          setNameInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            goTo();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setNameDraft(null);
            setNameInvalid(false);
            onCancel();
          }
        }}
        onBlur={() => {
          setNameDraft(null);
          setNameInvalid(false);
        }}
      />
      <SquareFunction className="sheet-fx" size={16} aria-hidden />
      <input
        ref={input}
        className="sheet-formula-input"
        aria-label={`Contents of ${label}`}
        value={shown}
        readOnly={!editable}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint={touch ? 'next' : 'done'}
        onFocus={() => {
          if (!draftRef.current && editable) begin({ ...active, sheet }, text);
        }}
        onChange={(e) => {
          const d = draftRef.current;
          if (d) begin(d.target, e.target.value);
          else begin({ ...active, sheet }, e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit('none')}
      />
      {error && (
        <span className="sheet-formula-error" title={error}>
          {error}
        </span>
      )}
    </div>
  );
});
