// A1 cell references for the .sheet format (ROADMAP item 6, DESIGN §6.21). Columns run A..XFD and
// rows 1..1048576, Excel's and Google Sheets' limits. Indexes are 0-based; A1 strings are 1-based.

export const MAX_COLUMNS = 16384;
export const MAX_ROWS = 1048576;

export interface CellRef {
  col: number;
  row: number;
}

const A1 = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

/** 'A' → 0, 'Z' → 25, 'AA' → 26; -1 for anything that is not an upper-case column within the limits. */
export function columnIndex(letters: string): number {
  if (!/^[A-Z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n <= MAX_COLUMNS ? n - 1 : -1;
}

/** 0 → 'A', 26 → 'AA'. */
export function columnLetters(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A canonical A1 key ('B10': upper case, no `$`) within the limits, or null. */
export function parseA1(key: string): CellRef | null {
  const m = A1.exec(key);
  if (!m) return null;
  const col = columnIndex(m[1]);
  const row = Number(m[2]) - 1;
  return col >= 0 && row < MAX_ROWS ? { col, row } : null;
}

export function toA1(col: number, row: number): string {
  return columnLetters(col) + (row + 1);
}

/** Accepts hand-written keys (' b10 ', '$B$10') and returns the canonical form, or null. */
export function normalizeA1(key: string): string | null {
  const k = key.trim().toUpperCase().replace(/\$/g, '');
  const ref = parseA1(k);
  return ref ? toA1(ref.col, ref.row) : null;
}

/** Canonical row key ('7') for a 1-based row number written by hand ('007', ' 7 '), or null. */
export function normalizeRowKey(key: string): string | null {
  const k = key.trim();
  if (!/^[0-9]{1,7}$/.test(k)) return null;
  const n = Number(k);
  return n >= 1 && n <= MAX_ROWS ? String(n) : null;
}

/** Canonical column key ('AB') for hand-written letters ('ab', '$AB'), or null. */
export function normalizeColumnKey(key: string): string | null {
  const k = key.trim().toUpperCase().replace(/^\$/, '');
  return columnIndex(k) >= 0 ? k : null;
}

/** Row-major order of canonical A1 keys: A1, B1, ..., A2. */
export function compareA1(a: string, b: string): number {
  const x = parseA1(a);
  const y = parseA1(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  return x.row - y.row || x.col - y.col;
}

export function compareColumns(a: string, b: string): number {
  return columnIndex(a) - columnIndex(b);
}
