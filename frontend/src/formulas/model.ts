// Formulas in notes (ROADMAP item 39, DESIGN §6.41): what a note's formulas are made of, without the
// engine. Every Markdown table is a small sheet (columns A, B, …; the header is row 1), a cell whose
// text starts with `=` is a formula, and inline code that starts with `=` is an inline formula. A
// table named with an Obsidian block id (a `^budget` line under it, after a blank line) is the sheet
// `budget` for references from elsewhere in the note (39b), and a `%% formats: B=currency %%` line
// there gives its columns number formats. Pure and DOM-free; the engine (engine.ts) is a lazy chunk.
import { FORMAT_PRESETS, formatGeneral } from '../sheets/numfmt';

/** One table of the note as the engine sees it. */
export interface FormulaTable {
  /** The sheet's name in formulas: the table's block id, else `Table1`, `Table2`, … in note order. */
  name: string;
  /** Whether the name comes from a block id (named tables are what 39b references). */
  named: boolean;
  /** The grid's cells: `rows[0]` is the header (row 1 in formulas). */
  rows: readonly (readonly string[])[];
  /** Number formats by column index (from the `%% formats … %%` line). */
  formats: Readonly<Record<number, string>>;
}

export interface FormulaModel {
  tables: readonly FormulaTable[];
}

/**
 * Whether a cell's or inline code's text is a formula: it starts with `=` and has something after
 * it. `==highlight==` (Obsidian's highlight) is text, not a formula.
 */
export function isFormula(text: string): boolean {
  const t = text.trim();
  return t.length > 1 && t.startsWith('=') && !t.startsWith('==');
}

/** Whether a table holds any formula, or has number formats to apply. */
export function tableNeedsEngine(table: Pick<FormulaTable, 'rows' | 'formats'>): boolean {
  return Object.keys(table.formats).length > 0 || table.rows.some((row) => row.some(isFormula));
}

/** Emphasis, strike-through and highlight markers that wrap a whole cell (`**1450**`). */
const WRAPPERS = ['**', '__', '~~', '==', '*', '_'];

function unwrap(text: string): string {
  let t = text;
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of WRAPPERS) {
      if (t.length > 2 * w.length && t.startsWith(w) && t.endsWith(w)) {
        t = t.slice(w.length, -w.length).trim();
        changed = true;
      }
    }
  }
  return t;
}

/** A number written with thousands separators (`1,450`, `-$12,000.50`, `1,234%`). */
const GROUPED = /^([-+]?[$€£¥]?)(\d{1,3}(?:,\d{3})+)(\.\d+)?(%?)$/;

/**
 * What the engine gets for a cell: a formula as typed, otherwise the cell's text without the
 * Markdown that wraps it and without thousands separators, which the engine then reads as a
 * number, a percentage, a currency amount, a date, TRUE/FALSE or text, as a spreadsheet would.
 */
export function engineInput(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  if (isFormula(t)) return t;
  // Backslash escapes (`\*`) are the character itself.
  const plain = unwrap(t).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const grouped = GROUPED.exec(plain);
  if (grouped) return grouped[1] + grouped[2].replace(/,/g, '') + (grouped[3] ?? '') + grouped[4];
  // Text that would read as a formula once unwrapped (`**=x**`) stays text.
  return plain.startsWith('=') ? `'${plain}` : plain;
}

// ---------- names and formats under a table ----------

/** A line that holds nothing but a block id (as features/blocks.ts reads it). */
const ID_LINE = /^\s*\^([A-Za-z0-9-]+)\s*$/;
/** `%% formats: B=currency C=0.0% %%` (a comment line Obsidian hides). */
const FORMATS_LINE = /^\s*%%\s*formats?\s*:?\s*(.*?)\s*%%\s*$/i;

const PRESETS = new Map(FORMAT_PRESETS.filter((p) => p.fmt !== undefined && p.fmt !== '@').map((p) => [p.id.toLowerCase(), p.fmt as string]));
PRESETS.set('integer', '#,##0');
PRESETS.set('decimal', '#,##0.00');

/** A column's format as written: a preset name (`currency`, `percent`, `number`, `date`, …) or a format code. */
export function formatCode(written: string): string {
  return PRESETS.get(written.toLowerCase()) ?? written;
}

/** Column letters (A, B, … AA) to a 0-based index; -1 if they are not letters. */
export function columnIndexOf(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The formats of a `%% formats … %%` line, by column index; null if the line is not one. */
export function parseFormatsLine(line: string): Record<number, string> | null {
  const m = FORMATS_LINE.exec(line);
  if (!m) return null;
  const out: Record<number, string> = {};
  for (const part of m[1].split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const column = columnIndexOf(part.slice(0, eq));
    const code = part.slice(eq + 1);
    if (column >= 0 && code !== '') out[column] = formatCode(code);
  }
  return out;
}

export interface TableAnnotations {
  id: string | null;
  formats: Record<number, string>;
}

/**
 * The block id and column formats written under a table: `lines` are the lines after its last
 * line. A blank line comes first (a line right under a table is one of its rows), then the
 * `^id` line and the formats line, in either order.
 */
export function tableAnnotations(lines: readonly string[]): TableAnnotations {
  const out: TableAnnotations = { id: null, formats: {} };
  let i = 0;
  if (lines[i] === undefined || lines[i].trim() !== '') return out;
  i++;
  let formatsSeen = false;
  for (; i < lines.length && i < 3; i++) {
    const id = ID_LINE.exec(lines[i]);
    if (id && out.id === null) {
      out.id = id[1];
      continue;
    }
    const formats = formatsSeen ? null : parseFormatsLine(lines[i]);
    if (formats) {
      out.formats = formats;
      formatsSeen = true;
      continue;
    }
    break;
  }
  return out;
}

/** Sheet names for the note's tables: block ids, else `Table1`, `Table2` (skipping names an id took). */
export function sheetNames(ids: readonly (string | null)[]): string[] {
  const taken = new Set(ids.filter((id): id is string => id !== null).map((id) => id.toLowerCase()));
  const used = new Set<string>();
  return ids.map((id, i) => {
    if (id !== null && !used.has(id.toLowerCase())) {
      used.add(id.toLowerCase());
      return id;
    }
    let n = i + 1;
    while (taken.has(`table${n}`) || used.has(`table${n}`)) n++;
    used.add(`table${n}`);
    return `Table${n}`;
  });
}

// ---------- the note's switch ----------

/** `formulas: false` (or `no`, `off`) in the frontmatter turns a note's formulas off. */
const OFF = /^formulas[ \t]*:[ \t]*(?:false|no|off)[ \t]*(?:#.*)?$/im;

export function formulasOff(frontmatterYaml: string | null): boolean {
  return frontmatterYaml !== null && OFF.test(frontmatterYaml);
}

// ---------- showing results ----------

/** What a formula's result shows as (a table cell, or inline). */
export interface FormulaDisplay {
  text: string;
  className?: string;
  /** Shown on hover: an error's message, or the formula. */
  title?: string;
}

/**
 * A number with no format: the Automatic format of the sheets (item 6), with thousands separators
 * from five digits on (`1725`, `17,400`), as in running text.
 */
export function formatAuto(n: number): string {
  const general = formatGeneral(n);
  if (/E/.test(general) || Math.abs(n) < 10000) return general;
  const [int, frac] = general.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = sign ? int.slice(1) : int;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? `.${frac}` : '');
}

/** What each error code means, for the hover text when the engine gives no message. */
export const ERROR_HELP: Record<string, string> = {
  '#DIV/0!': 'Division by zero',
  '#REF!': 'The formula refers to a cell that does not exist',
  '#NAME?': 'Unknown function or name',
  '#VALUE!': 'A value has the wrong type',
  '#N/A': 'No value is available',
  '#NUM!': 'The number is out of range',
  '#CYCLE!': 'The formula refers to itself',
  '#ERROR!': 'The formula cannot be read',
  '#SPILL!': 'The result needs cells that are not empty',
};
