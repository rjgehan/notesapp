// Formulas in notes (ROADMAP item 39, DESIGN §6.42): the note's tables as the sheets of one
// HyperFormula instance, with item 6's configuration, so every function behaves as it does in a
// `.sheet` file. A lazy chunk (load.ts), loaded only for notes that hold formulas. Results are never
// written into the note: they are computed from its text each time it changes.
import { CellValueDetailedType, DetailedCellError, HyperFormula, type CellValue, type RawCellContent } from 'hyperformula';
import { engineConfig } from '../sheets/engine';
import { friendlyError } from '../sheets/functions';
import { formatNumberWith, isGeneral } from '../sheets/numfmt';
import { engineInput, ERROR_HELP, formatAuto, isFormula, type FormulaDisplay, type FormulaModel } from './model';

/** The sheet the inline formulas live in: a name no block id can have (ids are letters, digits and dashes). */
const INLINE_SHEET = '_inline';

/** The formats of the result types the engine tells apart (the sheets' defaults, DESIGN §6.21.8). */
const TYPE_FORMATS: Partial<Record<string, string>> = {
  [CellValueDetailedType.NUMBER_DATE]: 'yyyy-mm-dd',
  [CellValueDetailedType.NUMBER_DATETIME]: 'yyyy-mm-dd h:mm',
  [CellValueDetailedType.NUMBER_TIME]: 'h:mm:ss AM/PM',
  [CellValueDetailedType.NUMBER_PERCENT]: '0.00%',
  [CellValueDetailedType.NUMBER_CURRENCY]: '$#,##0.00',
};

function errorDisplay(e: DetailedCellError, formula: string): FormulaDisplay {
  const help = friendlyError(e.value, formula, e.message || ERROR_HELP[e.value] || 'Error');
  return { text: e.value, className: 'cm-formula-error', title: `${help}\n${formula}`, hint: help };
}

/** A value as it shows: in the column's format, else the format of its type, else the Automatic one. */
export function displayValue(value: CellValue, type: string | null, fmt: string | undefined, formula: string | null): FormulaDisplay | null {
  const title = formula ?? undefined;
  if (value instanceof DetailedCellError) return errorDisplay(value, formula ?? '');
  if (value === null) return formula ? { text: '', className: 'cm-formula-value', title } : null;
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', className: 'cm-formula-value', title };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { text: '#NUM!', className: 'cm-formula-error', title: `${ERROR_HELP['#NUM!']}\n${formula ?? ''}` };
    const format = fmt ?? (type ? TYPE_FORMATS[type] : undefined);
    const text = isGeneral(format) ? formatAuto(value) : formatNumberWith(value, format).text;
    return { text, className: 'cm-formula-value', title };
  }
  return { text: String(value), className: 'cm-formula-value', title };
}

/** Dataview's inline queries (`= this.file.name`) are not formulas: they stay as code. */
function looksLikeDataview(e: DetailedCellError): boolean {
  return e.value === '#ERROR!' || (e.value === '#NAME?' && /Named expression .*\..* not recognized/.test(e.message));
}

export interface NoteResults {
  /** A table cell's display, or null to show its Markdown. */
  cell(table: number, row: number, column: number): FormulaDisplay | null;
  /** An inline formula's display (`expression` with its `=`), or null to leave the code as it is. */
  inline(expression: string): FormulaDisplay | null;
  /** The engine's value of an expression, for scripts (ROADMAP 40b): numbers, text, booleans, null, or an error code. */
  evaluate(expression: string): unknown;
  destroy(): void;
}

/** Computes a note's formulas. The tables' sheets are built at once; inline formulas as they are asked for. */
export function computeNote(model: FormulaModel): NoteResults {
  const sheets: Record<string, RawCellContent[][]> = {};
  model.tables.forEach((t) => {
    sheets[t.name] = t.rows.map((row) => row.map((cell) => engineInput(cell)));
  });
  sheets[INLINE_SHEET] = [];
  let hf: HyperFormula | null;
  try {
    hf = HyperFormula.buildFromSheets(sheets, engineConfig());
  } catch (e) {
    // A name the engine refuses, say: every formula shows as typed rather than breaking the note.
    console.warn('[formulas] building the note’s sheets failed', e);
    hf = null;
  }
  const ids = model.tables.map((t) => hf?.getSheetId(t.name) ?? -1);
  const inlineId = hf?.getSheetId(INLINE_SHEET) ?? -1;
  const inlineRows = new Map<string, number>();
  const inlineShown = new Map<string, FormulaDisplay | null>();

  const inlineRow = (expression: string): number => {
    let row = inlineRows.get(expression);
    if (row === undefined) {
      row = inlineRows.size;
      inlineRows.set(expression, row);
      hf!.setCellContents({ sheet: inlineId, row, col: 0 }, [[expression]]);
    }
    return row;
  };

  return {
    cell(table, row, column) {
      const t = model.tables[table];
      if (!hf || !t || ids[table] < 0) return null;
      const text = t.rows[row]?.[column] ?? '';
      const formula = isFormula(text) ? text.trim() : null;
      const fmt = row > 0 ? t.formats[column] : undefined;
      // Plain cells show their Markdown, unless their column has a format (39b) or an array result spilled into them.
      if (!formula && text.trim() !== '' && fmt === undefined) return null;
      const address = { sheet: ids[table], row, col: column };
      const value = hf.getCellValue(address);
      if (!formula && (text.trim() === '' ? value === null : typeof value !== 'number')) return null;
      return displayValue(value, hf.getCellValueDetailedType(address), fmt, formula);
    },
    inline(expression) {
      if (!hf || inlineId < 0) return null;
      if (inlineShown.has(expression)) return inlineShown.get(expression)!;
      let shown: FormulaDisplay | null;
      try {
        const address = { sheet: inlineId, row: inlineRow(expression), col: 0 };
        const value = hf.getCellValue(address);
        shown = value instanceof DetailedCellError && looksLikeDataview(value) ? null : displayValue(value, hf.getCellValueDetailedType(address), undefined, expression);
      } catch {
        shown = null;
      }
      inlineShown.set(expression, shown);
      return shown;
    },
    evaluate(expression) {
      if (!hf || inlineId < 0) return null;
      const value = hf.getCellValue({ sheet: inlineId, row: inlineRow(expression), col: 0 });
      return value instanceof DetailedCellError ? { error: value.value, message: value.message } : value;
    },
    destroy() {
      hf?.destroy();
      hf = null;
    },
  };
}

export const engineVersion = HyperFormula.version;

export { functionCatalog } from '../sheets/functions';
