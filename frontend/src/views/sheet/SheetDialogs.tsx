// Dialogs of the spreadsheet view (DESIGN §6.21.5, §6.21.8–6.21.10): named ranges, column width
// (the way to resize a column on a phone, where the header's edge is too small to drag), number
// formats, charts and imports.
import { ChartColumn, ChartLine, ChartPie, Trash } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../../components/overlays/Modal';
import { columnLetters } from '../../sheets/a1';
import type { Separator } from '../../sheets/csv';
import { formatShown } from '../../sheets/display';
import type { Workbook } from '../../sheets/engine';
import { sameName, type CachedValue, type ChartProps, type ChartType, type Sheet } from '../../sheets/format';
import { FORMAT_PRESETS, isGeneral } from '../../sheets/numfmt';
import { parseRangeText, rangeText } from '../../sheets/refs';
import { DEFAULT_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from './gridModel';
import { SheetChart } from './SheetChart';

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

// ---------- number formats ----------

interface FormatProps {
  /** The format that applies to the active cell (none: Automatic). */
  current: string | undefined;
  /** The active cell's value, for the previews. */
  value: CachedValue;
  /** `B3`, `A1:C4`, or `columns B–D`. */
  target: string;
  onApply(fmt: string | undefined): void;
  onClose(): void;
}

/** The Number format dialog: the formats of Google Sheets with samples, and a custom format with a preview. */
export function NumberFormatDialog({ current, value, target, onApply, onClose }: FormatProps) {
  const [custom, setCustom] = useState(current ?? '');
  // The active number, or a sample one: a number format shows numbers.
  const sample: CachedValue = typeof value === 'number' ? value : 1234.5678;
  const preview = formatShown(sample, custom.trim() === '' ? undefined : custom).text;
  return (
    <Modal label={`Number format of ${target}`} onClose={onClose} className="sheet-format-dialog">
      <div className="dialog">
        <h2 className="dialog-title">Number format</h2>
        <p className="dialog-message muted">For {target}</p>
        <ul className="sheet-format-list">
          {FORMAT_PRESETS.map((p) => {
            const active = p.fmt === undefined ? isGeneral(current) : p.fmt === current;
            const shown = p.fmt === undefined ? formatShown(sample, undefined).text : p.fmt === '@' ? 'Text as typed' : p.sample;
            return (
              <li key={p.id}>
                <button type="button" className="sheet-format-option" aria-pressed={active} onClick={() => onApply(p.fmt)}>
                  <span>{p.label}</span>
                  <span className="sheet-format-sample">{shown}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <form
          className="sheet-format-custom"
          onSubmit={(e) => {
            e.preventDefault();
            onApply(custom.trim() === '' ? undefined : custom);
          }}
        >
          <label className="field">
            <span className="field-label">Custom format</span>
            <input
              className="text-input sheet-format-input"
              value={custom}
              placeholder={'#,##0.00 "kg"'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
          <p className="sheet-format-preview" aria-live="polite" aria-label="Preview">
            {preview === '' ? ' ' : preview}
          </p>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button button-primary">
              Apply
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

// ---------- charts ----------

interface ChartDialogProps {
  sheet: Sheet;
  initial: ChartProps;
  /** Editing a chart that exists (Save) or inserting one (Insert). */
  editing: boolean;
  onSave(props: ChartProps): void;
  onClose(): void;
}

const CHART_KINDS: Array<{ type: ChartType; label: string; icon: ReactNode }> = [
  { type: 'bar', label: 'Bar', icon: <ChartColumn size={16} aria-hidden /> },
  { type: 'line', label: 'Line', icon: <ChartLine size={16} aria-hidden /> },
  { type: 'pie', label: 'Pie', icon: <ChartPie size={16} aria-hidden /> },
];

/** Inserting or editing a chart: its kind, range, title and headers, with a live preview. */
export function ChartDialog({ sheet, initial, editing, onSave, onClose }: ChartDialogProps) {
  const [draft, setDraft] = useState<ChartProps>(initial);
  const parsed = draft.range ? parseRangeText(draft.range) : null;
  const rangeError =
    draft.range === undefined || draft.range.trim() === ''
      ? 'Choose the range to chart, such as A1:C7.'
      : !parsed
        ? `“${draft.range}” is not a range.`
        : parsed.sheet !== null && !sameName(parsed.sheet, sheet.name)
          ? 'A chart shows a range of its own sheet.'
          : null;
  const set = (patch: Partial<ChartProps>) => setDraft((d) => ({ ...d, ...patch }));
  const first = parsed?.range;
  const type = draft.type ?? 'bar';
  return (
    <Modal label={editing ? 'Edit chart' : 'Insert chart'} onClose={onClose} className="sheet-chart-dialog">
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (rangeError !== null || !parsed) return;
          const props: ChartProps = { ...draft, type, range: rangeText(parsed.range) };
          if (!props.title?.trim()) delete props.title;
          onSave(props);
        }}
      >
        <h2 className="dialog-title">{editing ? 'Edit chart' : 'Insert chart'}</h2>
        <div className="sheet-chart-kinds" role="radiogroup" aria-label="Chart type">
          {CHART_KINDS.map((k) => (
            <button key={k.type} type="button" role="radio" aria-checked={type === k.type} className="sheet-chart-kind" onClick={() => set({ type: k.type })}>
              {k.icon}
              {k.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Range</span>
          <input
            className="text-input sheet-format-input"
            value={draft.range ?? ''}
            aria-invalid={rangeError !== null}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => set({ range: e.target.value })}
          />
        </label>
        {rangeError && <p className="field-error">{rangeError}</p>}
        <label className="field">
          <span className="field-label">Title</span>
          <input className="text-input" value={draft.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={draft.headers === true} onChange={(e) => set({ headers: e.target.checked })} />
          Row {first ? first.row + 1 : 1} names the series
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={draft.labels === true} onChange={(e) => set({ labels: e.target.checked })} />
          Column {first ? columnLetters(first.col) : 'A'} labels the {type === 'pie' ? 'slices' : 'categories'}
        </label>
        <div className="sheet-chart-preview">{rangeError === null && <SheetChart sheet={sheet} chart={{ ...draft, type }} height={150} />}</div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={rangeError !== null}>
            {editing ? 'Save' : 'Insert'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- import ----------

export interface ImportChoice {
  /** Into new sheets of the open spreadsheet, or a new spreadsheet file next to it. */
  target: 'sheet' | 'file';
  separator: Separator;
  /** Numbers, dates and formulas read as typed; otherwise every field is text. */
  convert: boolean;
}

interface ImportProps {
  fileName: string;
  kind: 'csv' | 'workbook';
  /** The separator the file seems to use (CSV). */
  separator: Separator;
  /** Sheets in the workbook (Excel). */
  sheetCount?: number;
  /** New sheets can be added (the spreadsheet is editable). */
  canAddSheets: boolean;
  onImport(choice: ImportChoice): void;
  onClose(): void;
}

const SEPARATORS: Array<{ value: Separator; label: string }> = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
];

export function ImportDialog({ fileName, kind, separator, sheetCount, canAddSheets, onImport, onClose }: ImportProps) {
  const [choice, setChoice] = useState<ImportChoice>({ target: canAddSheets ? 'sheet' : 'file', separator, convert: true });
  const what = kind === 'csv' || sheetCount === 1 ? 'A new sheet' : `${sheetCount ?? 'Its'} new sheets`;
  return (
    <Modal label={`Import ${fileName}`} onClose={onClose}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onImport(choice);
        }}
      >
        <h2 className="dialog-title">Import “{fileName}”</h2>
        <fieldset className="sheet-import-targets">
          <legend className="field-label">Import as</legend>
          <label className="checkbox-field">
            <input type="radio" name="target" checked={choice.target === 'sheet'} disabled={!canAddSheets} onChange={() => setChoice((c) => ({ ...c, target: 'sheet' }))} />
            {what} in this spreadsheet
          </label>
          <label className="checkbox-field">
            <input type="radio" name="target" checked={choice.target === 'file'} onChange={() => setChoice((c) => ({ ...c, target: 'file' }))} />A new spreadsheet file
          </label>
        </fieldset>
        {kind === 'csv' && (
          <>
            <label className="field">
              <span className="field-label">Separator</span>
              <select className="text-input" value={choice.separator} onChange={(e) => setChoice((c) => ({ ...c, separator: e.target.value as Separator }))}>
                {SEPARATORS.map((s) => (
                  <option key={s.label} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={choice.convert} onChange={(e) => setChoice((c) => ({ ...c, convert: e.target.checked }))} />
              Convert text to numbers, dates and formulas
            </label>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Import
          </button>
        </div>
      </form>
    </Modal>
  );
}
