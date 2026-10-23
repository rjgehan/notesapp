// Help while a formula is typed (DESIGN §6.21.5, §6.42), shared by the spreadsheet view and the
// tables of notes: where a pointed-at cell's reference goes and what it becomes (a click, a tap, a
// second tap that makes a range), which function name is being typed (autocomplete), which call and
// argument the caret is in (the signature hint), which cells the formula refers to (their outlines),
// and a friendlier word for a `#NAME?` error. Pure and engine-free: the function list comes from the
// engine's lazy chunk (functions.ts) as data.
import { columnIndex, MAX_COLUMNS, MAX_ROWS, toA1 } from './a1';
import { formulaSheetName } from './format';
import { mapReferences, parseRangeText, rangeText, type CellRange } from './refs';

/** A cell a reference can point at: its sheet (a note's table name; null for the formula's own) and place. */
export interface RefAt {
  sheet: string | null;
  col: number;
  row: number;
}

/** A reference inserted by pointing: where it is in the text, so the next point replaces or extends it. */
export interface PickedSlot {
  start: number;
  end: number;
  text: string;
  /** The cell the reference started from (a range's first corner). */
  anchor?: RefAt;
  /** Whether it is a single cell (a second tap then makes it a range). */
  single?: boolean;
}

/** What a reference can follow: `=`, `(`, `,`, an operator, `:` (and `;`, `{` of array literals). */
const SLOT_BEFORE = /[=(,+\-*/^&<>:;{]\s*$/;

function inString(before: string): boolean {
  return (before.match(/"/g)?.length ?? 0) % 2 === 1;
}

/**
 * Where a reference pointed at now goes in formula `value` with the caret at `caret`: the span to
 * replace (empty to insert), or null when the caret is not where a reference can go (the click then
 * ends the edit, as in Google Sheets). `last` is the reference pointing inserted last.
 */
export function referenceSlot(value: string, caret: number, last: PickedSlot | null): { start: number; end: number } | null {
  if (!value.startsWith('=')) return null;
  if (last && last.end === caret && value.slice(last.start, last.end) === last.text) return { start: last.start, end: last.end };
  const before = value.slice(0, caret);
  if (inString(before)) return null;
  return SLOT_BEFORE.test(before) ? { start: caret, end: caret } : null;
}

/** The range from `a` to `b`, either way round. */
export function spanOf(a: { col: number; row: number }, b: { col: number; row: number }): CellRange {
  const col = Math.min(a.col, b.col);
  const row = Math.min(a.row, b.row);
  return { col, row, width: Math.abs(a.col - b.col) + 1, height: Math.abs(a.row - b.row) + 1 };
}

/**
 * How a point at cell `at` changes the formula: the span it rewrites and the range's first corner.
 * A `click` (or the first tap) puts in the cell, replacing the reference pointing put in last while
 * the caret is still after it. A second `tap` on a cell of the same sheet turns a single-cell
 * reference just put in into a range (`B2` then `B4` makes `B2:B4`, the way to make one on a
 * phone), and a tap after a range starts again with its cell. `extend` (Shift-click) always makes
 * a range from the last reference's first corner. Null when the caret is not where a reference goes.
 */
export function pickSlot(value: string, caret: number, last: PickedSlot | null, at: RefAt, gesture: 'click' | 'tap' | 'extend'): { start: number; end: number; anchor: RefAt } | null {
  const slot = referenceSlot(value, caret, last);
  if (!slot) return null;
  const replacing = last !== null && slot.start === last.start && slot.end === last.end && last.anchor !== undefined;
  const extend = replacing && last.anchor!.sheet === at.sheet && (gesture === 'extend' || (gesture === 'tap' && last.single === true));
  return { ...slot, anchor: extend ? last!.anchor! : at };
}

/** The reference from `anchor` to `at`: `B2`, `B2:C5`, with `prefix` (`budget!`) for another sheet. */
export function referenceText(anchor: RefAt, at: RefAt, prefix = ''): string {
  const range = spanOf(anchor, at);
  return prefix + (range.width === 1 && range.height === 1 ? toA1(range.col, range.row) : rangeText(range));
}

/** The prefix naming sheet `name` in a formula of sheet `own`: '' for its own sheet, else `name!` (quoted when needed). */
export function sheetPrefix(name: string | null, own: string | null): string {
  return name === null || name === own ? '' : `${formulaSheetName(name)}!`;
}

/** `value` with the reference from `anchor` to `at` in place of `start`…`end`; where the caret goes, and the slot to remember. */
export function placeReference(value: string, start: number, end: number, anchor: RefAt, at: RefAt, prefix = ''): { value: string; caret: number; pick: PickedSlot; range: CellRange } {
  const text = referenceText(anchor, at, prefix);
  const range = spanOf(anchor, at);
  const caret = start + text.length;
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret,
    pick: { start, end: caret, text, anchor, single: range.width === 1 && range.height === 1 },
    range,
  };
}

// ---------- functions: autocomplete and the signature hint ----------

/** A function of the engine, as the hint shows it. */
export interface FunctionInfo {
  name: string;
  params: Array<{ name: string; optional: boolean }>;
  /** How many of the last parameters repeat (`SUM(value1, [value2, …])`: 1). */
  repeat: number;
  /** Lower comes first among the suggestions (the common functions). */
  rank?: number;
}

/** The function name being typed at `caret` (`=SU|`): where it starts and what has been typed. */
export function completionAt(value: string, caret: number): { from: number; prefix: string } | null {
  if (!value.startsWith('=')) return null;
  const before = value.slice(0, caret);
  if (inString(before)) return null;
  const m = /[A-Za-z][A-Za-z0-9._]*$/.exec(before);
  if (!m) return null;
  const from = caret - m[0].length;
  if (!SLOT_BEFORE.test(value.slice(0, from)) || value.slice(0, from).endsWith(':')) return null;
  // The rest of the word after the caret, or the call already written: nothing to complete.
  if (/^[A-Za-z0-9._(]/.test(value.slice(caret))) return null;
  return { from, prefix: m[0] };
}

/** The functions whose names start with `prefix`, the common ones first, at most `limit`. */
export function suggestFunctions(catalog: readonly FunctionInfo[], prefix: string, limit = 8): FunctionInfo[] {
  const p = prefix.toUpperCase();
  if (p === '') return [];
  return catalog
    .filter((f) => f.name.startsWith(p) && f.name !== p)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The innermost function call the caret is in (`=ROUND(SUM(A1, |`): its name, the argument (from 0), and where its `(` is. */
export function callAt(value: string, caret: number): { name: string; arg: number; open: number } | null {
  if (!value.startsWith('=')) return null;
  const stack: Array<{ name: string | null; arg: number; open: number }> = [];
  for (let i = 1; i < caret && i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      // Strings and quoted sheet names: skip to their end ("" and '' escape).
      let j = i + 1;
      while (j < value.length) {
        if (value[j] === ch) {
          if (value[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      if (j >= caret) return null;
      i = j;
    } else if (ch === '(' || ch === '{') {
      const name = ch === '(' ? (/([A-Za-z_][A-Za-z0-9._]*)\s*$/.exec(value.slice(0, i))?.[1] ?? null) : null;
      stack.push({ name: name?.toUpperCase() ?? null, arg: 0, open: i });
    } else if (ch === ')' || ch === '}') stack.pop();
    else if ((ch === ',' || ch === ';') && stack.length > 0) stack[stack.length - 1].arg++;
  }
  // Inside a plain bracket or an array literal, the call around it is the one to show.
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f.name !== null) return { name: f.name, arg: f.arg, open: f.open };
  }
  return null;
}

/** The parts of a function's signature, the argument `arg` (from 0) active: `SUM(` `value1` `, ` `[value2, …]` `)`. */
export function signatureParts(info: FunctionInfo, arg: number): Array<{ text: string; active?: boolean }> {
  const fixed = info.params.length - info.repeat;
  const items: Array<{ text: string; active: boolean }> = [];
  for (let i = 0; i < fixed; i++) {
    const p = info.params[i];
    items.push({ text: p.optional ? `[${p.name}]` : p.name, active: arg === i });
  }
  if (info.repeat > 0) {
    const group = info.params.slice(fixed);
    const k = arg - fixed;
    const round = k >= 0 ? Math.floor(k / info.repeat) : -1;
    const pos = k >= 0 ? k % info.repeat : -1;
    group.forEach((p, i) => items.push({ text: p.optional ? `[${p.name}1]` : `${p.name}1`, active: round === 0 && pos === i }));
    const more = group.map((p) => `${p.name}2`).join(', ');
    items.push({ text: `[${more}, …]`, active: round >= 1 });
  }
  const parts: Array<{ text: string; active?: boolean }> = [{ text: `${info.name}(` }];
  items.forEach((item, i) => {
    if (i > 0) parts.push({ text: ', ' });
    parts.push(item.active ? item : { text: item.text });
  });
  parts.push({ text: ')' });
  return parts;
}

// ---------- the cells a formula refers to ----------

/** The ranges a formula refers to, in order, with the sheet each names (null: its own). Whole columns and rows reach to `rows`/`cols`. */
export function formulaRanges(value: string, extent: { rows: number; cols: number } = { rows: MAX_ROWS, cols: MAX_COLUMNS }): Array<{ sheet: string | null; range: CellRange }> {
  const out: Array<{ sheet: string | null; range: CellRange }> = [];
  if (!value.startsWith('=')) return out;
  mapReferences(value, (ref) => {
    let range: CellRange | null = null;
    if (ref.kind === 'cell' || ref.kind === 'cells') range = parseRangeText(ref.parts.join(':'))?.range ?? null;
    else if (ref.kind === 'columns') {
      const [a, b] = ref.parts.map((p) => columnIndex(p.replace('$', '').toUpperCase()));
      if (a >= 0 && b >= 0) range = { col: Math.min(a, b), row: 0, width: Math.abs(a - b) + 1, height: extent.rows };
    } else {
      const [a, b] = ref.parts.map((p) => Number(p.replace('$', '')) - 1);
      if (a >= 0 && b >= 0) range = { col: 0, row: Math.min(a, b), width: extent.cols, height: Math.abs(a - b) + 1 };
    }
    if (range) out.push({ sheet: ref.sheet, range });
    return { text: ref.parts.join(':') };
  });
  return out;
}

// ---------- a friendlier #NAME? ----------

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/**
 * What to say about a `#NAME?` in `formula`, given the engine's function names: a function name
 * without its brackets (`=SUM`) is "Did you mean SUM(…)?"; an unknown function close to a known
 * one (`=SUMM(A1)`) names that one. Null when neither applies.
 */
export function nameHint(formula: string, names: ReadonlySet<string>): string | null {
  if (!formula.startsWith('=')) return null;
  const token = /"(?:[^"]|"")*"?|'(?:[^']|'')*'!?|([A-Za-z_][A-Za-z0-9._]*)(\s*\()?(!)?/g;
  let m: RegExpExecArray | null;
  let unknown: string | null = null;
  while ((m = token.exec(formula))) {
    const word = m[1];
    if (!word || m[3]) continue;
    const upper = word.toUpperCase();
    const prev = formula[m.index - 1];
    if (prev && /[A-Za-z0-9_.$]/.test(prev)) continue;
    if (m[2]) {
      if (!names.has(upper) && unknown === null) unknown = upper;
      continue;
    }
    if (upper === 'TRUE' || upper === 'FALSE' || /^\$?[A-Z]{1,3}\$?[0-9]+$/.test(upper)) continue;
    if (names.has(upper)) return `Did you mean ${upper}(…)?`;
  }
  if (unknown === null) return null;
  let best: string | null = null;
  let bestDistance = 3;
  for (const name of names) {
    if (Math.abs(name.length - unknown.length) >= bestDistance) continue;
    const d = distance(unknown, name);
    if (d < bestDistance || (d === bestDistance && best !== null && name < best)) {
      best = name;
      bestDistance = d;
    }
  }
  return best ? `Unknown function ${unknown}. Did you mean ${best}?` : `Unknown function ${unknown}`;
}
