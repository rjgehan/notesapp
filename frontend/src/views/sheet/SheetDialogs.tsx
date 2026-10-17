// Dialogs of the spreadsheet view (DESIGN §6.21.5): named ranges, and column width (the way to
// resize a column on a phone, where the header's edge is too small to drag).
import { Trash } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from '../../components/overlays/Modal';
import type { Workbook } from '../../sheets/engine';
import { sameName } from '../../sheets/format';
import { DEFAULT_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from './gridModel';

const stripEquals = (s: string) => s.trim().replace(/^=\s*/, '');

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface NamedProps {
  /** The parent re-renders the dialog after every change of the workbook. */
  workbook: Workbook;
  editable: boolean;
  /** The current selection as an absolute reference, offered for a new name. */
  selectionRef: string;
  onGoTo(name: string): void;
  onClose(): void;
}

function NamedRow({ name, expression, editable, workbook, onGoTo }: { name: string; expression: string; editable: boolean; workbook: Workbook; onGoTo(name: string): void }) {
  const [value, setValue] = useState(expression);
  const [shown, setShown] = useState(expression);
  const [error, setError] = useState<string | null>(null);
  // Another device (or undo) changed the range while the dialog is open.
  if (shown !== expression) {
    setShown(expression);
    setValue(expression);
  }
  const save = () => {
    const next = stripEquals(value);
    if (next === expression) return;
    if (next === '') {
      setError('A named range needs a range or a value.');
      return;
    }
    try {
      workbook.setNamed(name, next);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <li className="sheet-named-row">
      <button type="button" className="sheet-named-name" title={`Go to ${name}`} onClick={() => onGoTo(name)}>
        {name}
      </button>
      <input
        className="text-input sheet-named-expression"
        aria-label={`Range of ${name}`}
        value={value}
        readOnly={!editable}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={error !== null}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      />
      {editable && (
        <button type="button" className="icon-button" aria-label={`Delete ${name}`} title="Delete" onClick={() => workbook.setNamed(name, null)}>
          <Trash size={16} />
        </button>
      )}
      {error && (
        <p className="field-error sheet-named-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function NamedRangesDialog({ workbook, editable, selectionRef, onGoTo, onClose }: NamedProps) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState(selectionRef);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const names = Object.entries(workbook.file.named).sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const problems = workbook.problems;

  useLayoutEffect(() => {
    if (editable) nameInput.current?.focus();
  }, [editable]);

  const add = () => {
    const n = name.trim();
    const e = stripEquals(expression);
    if (n === '' || e === '') {
      setError('Give the range a name and a range or a value.');
      return;
    }
    if (names.some(([existing]) => sameName(existing, n))) {
      setError(`There is already a range named "${n}".`);
      return;
    }
    try {
      workbook.setNamed(n, e);
      setName('');
      setExpression(selectionRef);
      setError(null);
      nameInput.current?.focus();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Modal label="Named ranges" onClose={onClose} className="sheet-named-dialog" describedBy={error ? errorId : undefined}>
      <div className="dialog">
        <h2 className="dialog-title">Named ranges</h2>
        {problems.length > 0 && (
          <ul className="sheet-named-problems">
            {problems.map((p) => (
              <li key={p} className="note-warning">
                {p}
              </li>
            ))}
          </ul>
        )}
        {names.length === 0 ? (
          <p className="dialog-message muted">No named ranges yet. A name can stand for a range (=SUM(Costs)) or a value (=Price*TaxRate).</p>
        ) : (
          <ul className="sheet-named-list">
            {names.map(([n, expr]) => (
              <NamedRow key={n} name={n} expression={expr} editable={editable} workbook={workbook} onGoTo={onGoTo} />
            ))}
          </ul>
        )}
        {editable && (
          <form
            className="sheet-named-add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <label className="field">
              <span className="field-label">Name</span>
              <input
                ref={nameInput}
                className="text-input"
                value={name}
                placeholder="Total"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Range or value</span>
              <input
                className="text-input"
                value={expression}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  setExpression(e.target.value);
                  setError(null);
                }}
              />
            </label>
            {error && (
              <p id={errorId} className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="button" onClick={onClose}>
                Done
              </button>
              <button type="submit" className="button button-primary">
                Add
              </button>
            </div>
          </form>
        )}
        {!editable && (
          <div className="dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

interface WidthProps {
  /** `B`, or `B–D` for several columns. */
  label: string;
  width: number;
  onApply(width: number | null): void;
  onClose(): void;
}

export function ColumnWidthDialog({ label, width, onApply, onClose }: WidthProps) {
  const [value, setValue] = useState(String(width));
  const input = useRef<HTMLInputElement>(null);
  const n = Number(value);
  const valid = Number.isFinite(n) && n >= MIN_COLUMN_WIDTH && n <= MAX_COLUMN_WIDTH;

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <Modal label={`Width of column ${label}`} onClose={onClose}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onApply(Math.round(n));
        }}
      >
        <h2 className="dialog-title">Width of column {label}</h2>
        <label className="field">
          <span className="field-label">
            Width in pixels ({MIN_COLUMN_WIDTH}–{MAX_COLUMN_WIDTH})
          </span>
          <input ref={input} className="text-input" type="number" inputMode="numeric" min={MIN_COLUMN_WIDTH} max={MAX_COLUMN_WIDTH} value={value} aria-invalid={!valid} onChange={(e) => setValue(e.target.value)} />
        </label>
        <input
          className="sheet-width-slider"
          type="range"
          aria-label="Width"
          min={MIN_COLUMN_WIDTH}
          max={400}
          value={Math.min(400, valid ? n : width)}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="dialog-actions dialog-actions-wrap">
          <button type="button" className="button" onClick={() => onApply(null)} title={`Back to ${DEFAULT_COLUMN_WIDTH} px`}>
            Reset
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!valid}>
            Apply
          </button>
        </div>
      </form>
    </Modal>
  );
}
