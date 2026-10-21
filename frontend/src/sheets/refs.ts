// Cell references inside formulas (DESIGN §6.21.5): moving a formula by some rows and columns, as
// fill and paste do, shifts its relative references (`A1`, `B$2`, `C:C`, `3:3`) and keeps absolute
// ones (`$A$1`). Text in strings, quoted sheet names, function names and named ranges never
// changes. A reference pushed off the sheet becomes `#REF!`, as in Google Sheets and Excel. Moving
// cells (a cut and paste) instead makes the references to them follow (`moveReferences`), and
// renaming sheets renames the references to them (`renameSheetsInFormula`).
// Pure and engine-free, so the grid uses it without waiting for HyperFormula.
import { columnIndex, columnLetters, MAX_COLUMNS, MAX_ROWS } from './a1';
import { formulaSheetName, sameName } from './format';

/** A rectangle of cells, 0-based and inclusive of `col`/`row`, `width`/`height` at least 1. */
export interface CellRange {
  col: number;
  row: number;
  width: number;
  height: number;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;
const COLUMN = /^(\$?)([A-Za-z]{1,3})$/;
const ROW = /^(\$?)([0-9]{1,7})$/;
const WORD = /[\p{L}\p{N}_.$\\]/u;
const ERROR_LITERAL = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CYCLE!|ERROR!|LIC!|CALC!|GETTING_DATA)/i;
const NUMBER = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const ROW_RANGE = /^\$?[0-9]{1,7}:\$?[0-9]{1,7}/;

type Shift = (part: string) => string | null;

function shiftCell(dRow: number, dCol: number): Shift {
  return (part) => {
    const m = CELL.exec(part);
    if (!m) return part;
    let col = columnIndex(m[2].toUpperCase());
    let row = Number(m[4]) - 1;
    if (col < 0 || row >= MAX_ROWS) return part;
    if (m[1] === '') col += dCol;
    if (m[3] === '') row += dRow;
    if (col < 0 || col >= MAX_COLUMNS || row < 0 || row >= MAX_ROWS) return null;
    return `${m[1]}${columnLetters(col)}${m[3]}${row + 1}`;
  };
}

function shiftColumn(dCol: number): Shift {
  return (part) => {
    const m = COLUMN.exec(part);
    if (!m) return part;
    let col = columnIndex(m[2].toUpperCase());
    if (col < 0) return part;
    if (m[1] === '') col += dCol;
    if (col < 0 || col >= MAX_COLUMNS) return null;
    return m[1] + columnLetters(col);
  };
}

function shiftRow(dRow: number): Shift {
  return (part) => {
    const m = ROW.exec(part);
    if (!m) return part;
    let row = Number(m[2]) - 1;
    if (row < 0 || row >= MAX_ROWS) return part;
    if (m[1] === '') row += dRow;
    if (row < 0 || row >= MAX_ROWS) return null;
    return m[1] + String(row + 1);
  };
}

const isWordChar = (ch: string | undefined) => ch !== undefined && WORD.test(ch);

function readWord(text: string, from: number): string {
  let end = from;
  while (end < text.length && isWordChar(text[end])) end++;
  return text.slice(from, end);
}

/** The end of a quoted run starting at `from` (`"…"` or `'…'`, the quote doubled inside). */
function quotedEnd(text: string, from: number): number {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2;
      else return i + 1;
    } else i++;
  }
  return text.length;
}

/** A reference in a formula, as mapReferences() finds it. */
export interface FormulaRef {
  /** The sheet prefix as written, with its `!` (`Data!`, `'My data'!`); '' without one. */
  prefix: string;
  /** The sheet the prefix names (unquoted), or null without a prefix. */
  sheet: string | null;
  kind: 'cell' | 'cells' | 'columns' | 'rows';
  /** As written after the prefix: one part for a cell (`B$2`), two for a range (`A1`, `C3`; `A`, `C`; `3`, `5`). */
  parts: string[];
}

/**
 * What a reference becomes: its new text, and its new sheet prefix (with `!`, or '' for none) when
 * that changes; null for `#REF!` (the prefix goes too).
 */
export type RefReplacement = { text: string; prefix?: string } | null;

/**
 * `formula` with every cell, range, column and row reference replaced by what `map` makes of it.
 * Strings, quoted sheet names, function names, error literals, numbers and named ranges are copied
 * as they are. Anything that is not a formula is returned as it is.
 */
export function mapReferences(formula: string, map: (ref: FormulaRef) => RefReplacement): string {
  if (!formula.startsWith('=')) return formula;
  let out = '';
  let i = 0;
  // A sheet prefix just written to `out`, waiting for the reference it qualifies.
  let pending: { start: number; text: string; name: string } | null = null;
  const emit = (kind: FormulaRef['kind'], parts: string[]) => {
    const result = map({ prefix: pending?.text ?? '', sheet: pending?.name ?? null, kind, parts });
    const before = pending ? out.slice(0, pending.start) : out;
    if (result === null) out = before + '#REF!';
    else if (result.prefix === undefined) out += result.text;
    else out = before + result.prefix + result.text;
    pending = null;
  };
  while (i < formula.length) {
    const ch = formula[i];
    const prev = i > 0 ? formula[i - 1] : undefined;
    if (ch === '"') {
      const end = quotedEnd(formula, i);
      out += formula.slice(i, end);
      i = end;
      pending = null;
      continue;
    }
    if (ch === "'") {
      const end = quotedEnd(formula, i);
      const start = out.length;
      const quoted = formula.slice(i, end);
      out += quoted;
      i = end;
      if (formula[i] === '!') {
        out += '!';
        i++;
        pending = { start, text: quoted + '!', name: quoted.slice(1, -1).replace(/''/g, "'") };
      } else pending = null;
      continue;
    }
    if (ch === '#') {
      const m = ERROR_LITERAL.exec(formula.slice(i));
      const len = m ? m[0].length : 1;
      out += formula.slice(i, i + len);
      i += len;
      pending = null;
      continue;
    }
    if (/[0-9.]/.test(ch) && !isWordChar(prev)) {
      const rest = formula.slice(i);
      const range = ROW_RANGE.exec(rest);
      if (range && !isWordChar(rest[range[0].length]) && rest[range[0].length] !== '(') {
        emit('rows', range[0].split(':'));
        i += range[0].length;
        continue;
      }
      const number = NUMBER.exec(rest);
      const len = number ? number[0].length : 1;
      // A number glued to letters (`1E3` is a number, `2A` is not valid anyway) is copied whole.
      out += rest.slice(0, len);
      i += len;
      pending = null;
      continue;
    }
    if (ch === '$' && /[0-9]/.test(formula[i + 1] ?? '') && !isWordChar(prev)) {
      // `$3:$5`, an absolute row range.
      const range = ROW_RANGE.exec(formula.slice(i));
      if (range) {
        emit('rows', range[0].split(':'));
        i += range[0].length;
        continue;
      }
    }
    if (isWordChar(ch)) {
      const word = readWord(formula, i);
      const after = i + word.length;
      const next = formula[after];
      if (next === '(') {
        out += word;
        i = after;
        pending = null;
        continue;
      }
      if (next === '!') {
        pending = { start: out.length, text: word + '!', name: word };
        out += word + '!';
        i = after + 1;
        continue;
      }
      if (CELL.test(word)) {
        if (next === ':') {
          const second = readWord(formula, after + 1);
          if (CELL.test(second) && formula[after + 1 + second.length] !== '(' && formula[after + 1 + second.length] !== '!') {
            emit('cells', [word, second]);
            i = after + 1 + second.length;
            continue;
          }
        }
        emit('cell', [word]);
        i = after;
        continue;
      }
      if (COLUMN.test(word) && next === ':') {
        const second = readWord(formula, after + 1);
        if (COLUMN.test(second) && formula[after + 1 + second.length] !== '(') {
          emit('columns', [word, second]);
          i = after + 1 + second.length;
          continue;
        }
      }
      out += word;
      i = after;
      pending = null;
      continue;
    }
    out += ch;
    i++;
    if (ch !== ' ') pending = null;
  }
  return out;
}

/**
 * `formula` moved by `dRow` rows and `dCol` columns: its relative references follow, absolute
 * ones stay. Anything that is not a formula is returned as it is.
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (!formula.startsWith('=') || (dRow === 0 && dCol === 0)) return formula;
  const shifts: Record<FormulaRef['kind'], Shift> = { cell: shiftCell(dRow, dCol), cells: shiftCell(dRow, dCol), columns: shiftColumn(dCol), rows: shiftRow(dRow) };
  return mapReferences(formula, (ref) => {
    const parts = ref.parts.map(shifts[ref.kind]);
    return parts.some((p) => p === null) ? null : { text: parts.join(':') };
  });
}

/** Cells moved by a cut and paste: `range` of sheet `sheet` now starts `dRow` rows and `dCol` columns away, on sheet `toSheet`. */
export interface CellMove {
  sheet: string;
  range: CellRange;
  toSheet: string;
  dRow: number;
  dCol: number;
}

/**
 * `formula` after `move`, as Excel and Google Sheets update formulas on a cut and paste:
 * references to cells and ranges that lie within the moved range follow it (absolute ones too), and
 * every other reference keeps pointing where it did. `home` is the sheet the formula was on and the
 * one it is on now (they differ for a moved formula; null for a named range, whose references all
 * name their sheet).
 */
export function moveReferences(formula: string, home: { from: string | null; to: string | null }, move: CellMove): string {
  const r = move.range;
  const inside = (m: RegExpExecArray | null) => {
    if (!m) return false;
    const col = columnIndex(m[2].toUpperCase());
    const row = Number(m[4]) - 1;
    return col >= r.col && col < r.col + r.width && row >= r.row && row < r.row + r.height;
  };
  return mapReferences(formula, (ref) => {
    const text = ref.parts.join(':');
    const target = ref.sheet ?? home.from;
    const cells = ref.kind === 'cell' || ref.kind === 'cells' ? ref.parts.map((p) => CELL.exec(p)) : [];
    const follows = target !== null && sameName(target, move.sheet) && cells.length > 0 && cells.every(inside);
    if (!follows) {
      // A formula moved to another sheet keeps its own-sheet references on the sheet it came from.
      if (ref.sheet === null && home.from !== null && home.to !== null && !sameName(home.from, home.to)) return { prefix: formulaSheetName(home.from) + '!', text };
      return { text };
    }
    const shifted = cells
      .map((m) => {
        const [, colAbs, col, rowAbs, row] = m as RegExpExecArray;
        return `${colAbs}${columnLetters(columnIndex(col.toUpperCase()) + move.dCol)}${rowAbs}${Number(row) + move.dRow}`;
      })
      .join(':');
    // A prefix that already names the destination stays as written; one the formula's own sheet makes unnecessary goes.
    if (ref.sheet !== null && sameName(ref.sheet, move.toSheet)) return { text: shifted };
    if (home.to !== null && sameName(home.to, move.toSheet)) return ref.sheet === null ? { text: shifted } : { prefix: '', text: shifted };
    return { prefix: formulaSheetName(move.toSheet) + '!', text: shifted };
  });
}

/**
 * `formula` with references to sheet `from` (any case, quoted or not) pointing at `to` instead: an
 * imported sheet that had to be renamed keeps its formulas. Strings are never changed.
 */
export function renameSheetInFormula(formula: string, from: string, to: string): string {
  return renameSheetsInFormula(formula, [[from, to]]);
}

/**
 * `formula` with several sheets renamed at once (`renames` pairs old and new names; old names in any
 * case). Each reference is renamed once, so renames that chain (`Sheet1` → `Sheet1 (2)` while
 * `Sheet1 (2)` → `Sheet1 (3)`) or swap two names point every reference at the right sheet.
 */
export function renameSheetsInFormula(formula: string, renames: Iterable<readonly [string, string]>): string {
  if (!formula.startsWith('=')) return formula;
  const targets = new Map<string, string>();
  for (const [from, to] of renames) if (!targets.has(from.toLowerCase())) targets.set(from.toLowerCase(), formulaSheetName(to));
  if (targets.size === 0) return formula;
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      const end = quotedEnd(formula, i);
      const quoted = formula.slice(i, end);
      const target = ch === "'" && formula[end] === '!' ? targets.get(quoted.slice(1, -1).replace(/''/g, "'").toLowerCase()) : undefined;
      out += target ?? quoted;
      i = end;
      continue;
    }
    if (isWordChar(ch) && !isWordChar(formula[i - 1])) {
      const word = readWord(formula, i);
      const target = formula[i + word.length] === '!' ? targets.get(word.toLowerCase()) : undefined;
      out += target ?? word;
      i += word.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------- ranges as text ----------

/** `B3`, or `B3:D7` for a larger range. */
export function rangeText(range: CellRange): string {
  const start = columnLetters(range.col) + (range.row + 1);
  if (range.width === 1 && range.height === 1) return start;
  return `${start}:${columnLetters(range.col + range.width - 1)}${range.row + range.height}`;
}

/** An absolute reference to `range` on sheet `sheetName`, for a named range: `Budget!$B$2:$B$9`. */
export function absoluteRangeText(sheetName: string, range: CellRange): string {
  const a = `$${columnLetters(range.col)}$${range.row + 1}`;
  const b = `$${columnLetters(range.col + range.width - 1)}$${range.row + range.height}`;
  return `${formulaSheetName(sheetName)}!${range.width === 1 && range.height === 1 ? a : `${a}:${b}`}`;
}

/**
 * Reads what was typed into the name box: `C10`, `a1:b3`, `$B$2`, `Budget!A1:C3` or
 * `'My sheet'!B2`. Null when it is not a reference.
 */
export function parseRangeText(text: string): { sheet: string | null; range: CellRange } | null {
  let rest = text.trim();
  let sheet: string | null = null;
  const bang = rest.lastIndexOf('!');
  if (bang >= 0) {
    const name = rest.slice(0, bang).trim();
    rest = rest.slice(bang + 1).trim();
    if (name.startsWith("'") && name.endsWith("'") && name.length >= 2) sheet = name.slice(1, -1).replace(/''/g, "'");
    else sheet = name;
    if (sheet === '') return null;
  }
  const [a, b, extra] = rest.split(':');
  if (extra !== undefined) return null;
  const first = CELL.exec(a ?? '');
  if (!first) return null;
  const col1 = columnIndex(first[2].toUpperCase());
  const row1 = Number(first[4]) - 1;
  let col2 = col1;
  let row2 = row1;
  if (b !== undefined) {
    const second = CELL.exec(b);
    if (!second) return null;
    col2 = columnIndex(second[2].toUpperCase());
    row2 = Number(second[4]) - 1;
  }
  if ([col1, col2].some((c) => c < 0) || [row1, row2].some((r) => r < 0 || r >= MAX_ROWS)) return null;
  const col = Math.min(col1, col2);
  const row = Math.min(row1, row2);
  return { sheet, range: { col, row, width: Math.abs(col2 - col1) + 1, height: Math.abs(row2 - row1) + 1 } };
}
