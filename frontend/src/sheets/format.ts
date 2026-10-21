// The .sheet file format (ROADMAP item 6, DESIGN §6.21): JSON owned by NotesApp and independent of
// the formula engine. parseSheet() validates a file and repairs what it can without losing data
// (anything it cannot place is refused, never dropped); serializeSheet() writes a stable layout,
// sheets in order and cells in row-major order, one cell per line, so a one-cell edit is a
// one-line diff. Nothing here loads the engine: embeds, search and merges work from this module.
import { compareA1, compareColumns, normalizeA1, normalizeColumnKey, normalizeRowKey } from './a1';
import { numberText, typedInput } from './input';

export const SHEET_TYPE = 'notesapp-sheet';
export const SHEET_VERSION = 1;
/**
 * The engine whose results new files carry. engine.test.ts checks it against the running
 * HyperFormula, so an engine upgrade cannot slip in without updating it.
 */
export const SHEET_ENGINE = 'hyperformula@3.4.0';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Keys this version does not know (or values it cannot use), kept and written back verbatim. */
export type Extra = Record<string, Json>;

export type CellValue = string | number | boolean;
/** An error result such as `#DIV/0!`. */
export type CellError = { e: string };
export type CachedValue = CellValue | CellError | null;

export interface SheetCell {
  /** Literal value. */
  v?: CellValue;
  /** Formula, starting with `=`. */
  f?: string;
  /** Cached result of the formula, or of an array formula spilling into this cell (a cell with only `c`). */
  c?: CachedValue;
  /** Number format, such as `0.0%`; before the row's and the column's (DESIGN §6.21.8). */
  fmt?: string;
  extra?: Extra;
}

export interface ColumnProps {
  /** Width in CSS pixels. */
  w?: number;
  /** Number format, such as `$#,##0.00`. */
  fmt?: string;
  bold?: boolean;
  extra?: Extra;
}

export interface RowProps {
  /** Height in CSS pixels. */
  h?: number;
  fmt?: string;
  bold?: boolean;
  extra?: Extra;
}

export interface Frozen {
  rows: number;
  cols: number;
}

export const CHART_TYPES = ['bar', 'line', 'pie'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** A chart of a range of its sheet (DESIGN §6.21.9). */
export interface ChartProps {
  type?: ChartType;
  /** A range of the chart's own sheet, such as `A1:C7`. */
  range?: string;
  title?: string;
  /** The range's first row names the series. */
  headers?: boolean;
  /** The range's first column labels the categories (the slices of a pie). */
  labels?: boolean;
  extra?: Extra;
}

export interface Sheet {
  /** Stable identity for merges; formulas refer to sheets by name. */
  id: string;
  name: string;
  /** Sparse, keyed by canonical A1 references. */
  cells: Record<string, SheetCell>;
  /** Keyed by column letters. */
  cols: Record<string, ColumnProps>;
  /** Keyed by 1-based row numbers. */
  rows: Record<string, RowProps>;
  frozen: Frozen;
  /** Keyed by chart id; shown in id order. Written only when there are any. */
  charts: Record<string, ChartProps>;
  extra?: Extra;
}

export interface SheetFile {
  type: typeof SHEET_TYPE;
  version: typeof SHEET_VERSION;
  /** The engine (`name@version`) that computed the `c` values; `''` when no single engine run did. */
  engine: string;
  sheets: Sheet[];
  /** Named ranges and constants: name → expression without the leading `=`, such as `Budget!$B$10`. */
  named: Record<string, string>;
  extra?: Extra;
}

export type ParseResult = { ok: true; file: SheetFile; repairs: string[] } | { ok: false; error: string };

const FILE_KEYS = ['type', 'version', 'engine', 'sheets', 'named'];
const SHEET_KEYS = ['id', 'name', 'cells', 'cols', 'rows', 'frozen', 'charts'];
const CELL_KEYS = ['v', 'f', 'c', 'fmt'];
const COLUMN_KEYS = ['w', 'fmt', 'bold'];
const ROW_KEYS = ['h', 'fmt', 'bold'];
const CHART_KEYS = ['type', 'range', 'title', 'headers', 'labels'];

class Refusal extends Error {}

const isObject = (x: unknown): x is Record<string, Json> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCellValue = (x: unknown): x is CellValue => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
const isCachedValue = (x: unknown): x is CachedValue =>
  x === null || isCellValue(x) || (isObject(x) && Object.keys(x).length === 1 && typeof x.e === 'string');
const isSize = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const quote = (s: string) => JSON.stringify(s);

// ---------- new files and names ----------

/** A new workbook with one empty sheet. */
export function newSheetFile(engine = SHEET_ENGINE): SheetFile {
  return { type: SHEET_TYPE, version: SHEET_VERSION, engine, sheets: [emptySheet('s1', 'Sheet1')], named: {} };
}

export function emptySheet(id: string, name: string): Sheet {
  return { id, name, cells: {}, cols: {}, rows: {}, frozen: { rows: 0, cols: 0 }, charts: {} };
}

/**
 * A random id for a new sheet. Random rather than sequential, so sheets added on two devices
 * never collide in a merge.
 */
export function newSheetId(file: Pick<SheetFile, 'sheets'>): string {
  const taken = new Set(file.sheets.map((s) => s.id));
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = 's' + Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    if (!taken.has(id)) return id;
  }
}

/**
 * An id for a new chart: the time in base 36, so ids sort in the order charts were made (the
 * order they show in), and a random tail, so charts made on two devices never collide.
 */
export function newChartId(sheet: Pick<Sheet, 'charts'>, now = Date.now()): string {
  const stamp = 'c' + now.toString(36).padStart(9, '0');
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const id = stamp + Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    if (!(id in sheet.charts)) return id;
  }
}

/** Sheet names are unique without regard to case, as in formulas. */
export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The first free `Sheet<n>`. */
export function nextSheetName(file: Pick<SheetFile, 'sheets'>): string {
  for (let n = file.sheets.length + 1; ; n++) {
    const name = `Sheet${n}`;
    if (!file.sheets.some((s) => sameName(s.name, name))) return name;
  }
}

/** Why `name` cannot name a sheet of `file` (other than the sheet `selfId`), or null. */
export function sheetNameProblem(name: string, file: { sheets: ReadonlyArray<{ id?: string; name: string }> }, selfId?: string): string | null {
  if (name.trim() === '') return 'A sheet needs a name.';
  if (name !== name.trim()) return 'A sheet name cannot start or end with a space.';
  if (name.length > 100) return 'A sheet name can be at most 100 characters.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f[\]*?/\\:]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
    return "A sheet name cannot contain [ ] * ? / \\ : or start or end with '.";
  }
  if (file.sheets.some((s) => (selfId === undefined || s.id !== selfId) && sameName(s.name, name))) return `There is already a sheet named "${name}".`;
  return null;
}

/**
 * A valid sheet name close to `wanted` (characters a name cannot hold become spaces) that no sheet
 * of `taken` has: `Data`, else `Data (2)`, `Data (3)`… For imported sheets.
 */
export function freeSheetName(wanted: string, taken: ReadonlyArray<{ name: string }>): string {
  // eslint-disable-next-line no-control-regex
  let base = wanted.replace(/[\u0000-\u001f[\]*?/\\:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 90) || 'Sheet';
  if (sheetNameProblem(base, { sheets: taken }) === null) return base;
  base = base.replace(/ \(\d+\)$/, '');
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`;
    if (sheetNameProblem(name, { sheets: taken }) === null) return name;
  }
}

/** A sheet name as written in a formula: quoted unless it is a plain identifier. */
export function formulaSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

// ---------- typed input ----------

/**
 * The content of a cell from what was typed into it (input.ts): `=…` is a formula, numbers,
 * percentages, amounts, dates and TRUE/FALSE are values, a leading `'` forces text, and an empty
 * string clears the cell (null). The number format a typed value implies is typedInput()'s.
 */
export function cellInput(text: string): Pick<SheetCell, 'v' | 'f'> | null {
  return typedInput(text).content;
}

/**
 * What the formula bar shows for a cell: the formula, or the value in a form cellInput() reads
 * back. `fmt` is the cell's number format: dates show as dates, percentages as percentages, and
 * in a plain-text cell (`@`) text shows as it is.
 */
export function cellText(cell: SheetCell | undefined, fmt?: string): string {
  if (!cell) return '';
  if (cell.f !== undefined) return cell.f;
  const v = cell.v;
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberText(v, fmt);
  if (fmt === '@') return v;
  const back = cellInput(v);
  return back !== null && back.v === v ? v : "'" + v;
}

/** The value a cell shows: its literal value, or the cached result of its formula. */
export function cellValue(cell: SheetCell | undefined): CachedValue {
  if (!cell) return null;
  if (cell.f !== undefined) return cell.c ?? null;
  return cell.v ?? cell.c ?? null;
}

export const isCellError = (x: CachedValue | undefined): x is CellError => typeof x === 'object' && x !== null;

/** A cell with neither content nor cached value nor format nor unknown keys, which the file does not keep. */
export const isEmptyCell = (cell: SheetCell) =>
  cell.v === undefined &&
  cell.f === undefined &&
  cell.c === undefined &&
  cell.fmt === undefined &&
  (!cell.extra || Object.keys(cell.extra).length === 0);

// ---------- parsing ----------

/**
 * Throws on the first object key that occurs twice: JSON.parse keeps only the last one, which
 * would silently drop a cell from a hand-edited file. Also refuses `__proto__`, which plain
 * objects cannot hold as an ordinary key. `text` is already known to be valid JSON.
 */
function checkKeys(text: string): void {
  const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top) top.expectKey = true;
    } else if (ch === '"') {
      const start = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++;
      const top = stack[stack.length - 1];
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (top.keys.has(key)) throw new Refusal(`The key ${quote(key)} appears twice in one object.`);
        if (key === '__proto__') throw new Refusal('The key "__proto__" is not supported.');
        top.keys.add(key);
        top.expectKey = false;
      }
    }
  }
}

/** Splits an object into its known keys and the rest (kept verbatim). */
function extraOf(raw: Record<string, Json>, known: string[]): Extra | undefined {
  const extra: Extra = {};
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) extra[k] = v;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function addExtra(target: { extra?: Extra }, key: string, value: Json): void {
  target.extra = { ...target.extra, [key]: value };
}

function parseCell(raw: Json, where: string, repairs: string[]): SheetCell | null {
  if (raw === null) {
    repairs.push(`${where} was null and is left empty.`);
    return null;
  }
  if (isCellValue(raw)) {
    repairs.push(`${where} held a bare value; it is stored as {"v": …}.`);
    return { v: raw };
  }
  if (!isObject(raw)) throw new Refusal(`${where} is a list, not a cell.`);
  const cell: SheetCell = {};
  const extra = extraOf(raw, CELL_KEYS);
  if (extra) cell.extra = extra;
  if ('f' in raw) {
    const f = raw.f;
    if (typeof f === 'string' && f.trim() !== '') {
      const t = f.trimStart();
      cell.f = t.startsWith('=') ? t : '=' + t;
      if (cell.f !== f) repairs.push(`${where}: the formula did not start with "=".`);
    } else if (typeof f === 'string' || f === null) {
      repairs.push(`${where}: an empty formula was removed.`);
    } else {
      addExtra(cell, 'f', f);
      repairs.push(`${where}: "f" is not a formula; it is kept unchanged but not calculated.`);
    }
  }
  if ('v' in raw) {
    const v = raw.v;
    if (v === null) {
      // No value: nothing to keep.
    } else if (!isCellValue(v)) {
      addExtra(cell, 'v', v);
      repairs.push(`${where}: "v" is not a text, number or true/false value; it is kept unchanged but not shown.`);
    } else if (cell.f !== undefined) {
      addExtra(cell, 'v', v);
      repairs.push(`${where} has both a value and a formula; the formula is used and the value kept aside.`);
    } else {
      cell.v = v;
    }
  }
  if ('c' in raw) {
    // The cache is derived data: an unusable one is dropped and recomputed.
    if (isCachedValue(raw.c)) cell.c = raw.c;
    else repairs.push(`${where}: an unreadable cached value will be recalculated.`);
  }
  if ('fmt' in raw) {
    if (typeof raw.fmt === 'string') cell.fmt = raw.fmt;
    else {
      addExtra(cell, 'fmt', raw.fmt);
      repairs.push(`${where}: "fmt" is not a number format; it is kept unchanged but not used.`);
    }
  }
  return isEmptyCell(cell) ? null : cell;
}

function parseKeyed<T>(
  raw: Json | undefined,
  what: string,
  normalize: (key: string) => string | null,
  parseValue: (value: Json, where: string) => T | null,
  repairs: string[],
): Record<string, T> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Refusal(`${what} is not an object.`);
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = normalize(key);
    if (k === null) throw new Refusal(`${what} has the key ${quote(key)}, which is not a valid reference.`);
    if (Object.hasOwn(out, k)) throw new Refusal(`${what} has both ${quote(key)} and another key for ${k}.`);
    if (k !== key) repairs.push(`${what}: ${quote(key)} is written as ${quote(k)}.`);
    const parsed = parseValue(value, `${what} ${k}`);
    if (parsed !== null) out[k] = parsed;
  }
  return out;
}

function parseLine<T extends ColumnProps | RowProps>(raw: Json, where: string, sizeKey: 'w' | 'h', known: string[], repairs: string[]): T | null {
  if (!isObject(raw)) throw new Refusal(`${where} is not an object.`);
  const props: ColumnProps & RowProps = {};
  const extra = extraOf(raw, known);
  if (extra) props.extra = extra;
  const keep = (key: string, value: Json) => {
    addExtra(props, key, value);
    repairs.push(`${where}: ${quote(key)} has an unusable value; it is kept unchanged.`);
  };
  if (sizeKey in raw) {
    const size = raw[sizeKey];
    if (isSize(size)) props[sizeKey] = size;
    else keep(sizeKey, size);
  }
  if ('fmt' in raw) {
    if (typeof raw.fmt === 'string') props.fmt = raw.fmt;
    else keep('fmt', raw.fmt);
  }
  if ('bold' in raw) {
    if (typeof raw.bold === 'boolean') props.bold = raw.bold;
    else keep('bold', raw.bold);
  }
  return props as T;
}

function parseChart(raw: Json, where: string, repairs: string[]): ChartProps {
  if (!isObject(raw)) throw new Refusal(`${where} is not an object.`);
  const chart: ChartProps = {};
  const extra = extraOf(raw, CHART_KEYS);
  if (extra) chart.extra = extra;
  const keep = (key: string, value: Json) => {
    addExtra(chart, key, value);
    repairs.push(`${where}: ${quote(key)} has an unusable value; it is kept unchanged.`);
  };
  if ('type' in raw) {
    const type = CHART_TYPES.find((t) => t === raw.type);
    if (type) chart.type = type;
    else keep('type', raw.type);
  }
  for (const key of ['range', 'title'] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value === 'string') chart[key] = value;
    else keep(key, value);
  }
  for (const key of ['headers', 'labels'] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value === 'boolean') chart[key] = value;
    else keep(key, value);
  }
  return chart;
}

function parseFrozen(raw: Json | undefined, where: string, repairs: string[]): Frozen {
  const frozen = { rows: 0, cols: 0 };
  if (raw === undefined) return frozen;
  if (!isObject(raw)) {
    repairs.push(`${where}: "frozen" is unreadable; no rows or columns are frozen.`);
    return frozen;
  }
  for (const key of ['rows', 'cols'] as const) {
    const n = raw[key];
    if (n === undefined) continue;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1000) frozen[key] = n;
    else repairs.push(`${where}: frozen ${key} ${JSON.stringify(n)} is unusable; it is reset to 0.`);
  }
  return frozen;
}

function parseSheetEntry(raw: Json, index: number, repairs: string[]): Sheet {
  const where = `Sheet ${index + 1}`;
  if (!isObject(raw)) throw new Refusal(`${where} is not an object.`);
  let name = '';
  if (typeof raw.name === 'string') name = raw.name;
  else if (typeof raw.name === 'number' || typeof raw.name === 'boolean') {
    name = String(raw.name);
    repairs.push(`${where}: the name ${raw.name} is stored as text.`);
  } else if (raw.name !== undefined) repairs.push(`${where}: the name is not text; a new one is assigned.`);
  if (raw.id !== undefined && typeof raw.id !== 'string') repairs.push(`${where}: the id is not text; a new one is assigned.`);
  const label = name !== '' ? `Sheet "${name}"` : where;
  const sheet: Sheet = {
    id: typeof raw.id === 'string' ? raw.id : '',
    name,
    cells: parseKeyed(raw.cells, `${label} cells`, normalizeA1, (v, w) => parseCell(v, w, repairs), repairs),
    cols: parseKeyed(raw.cols, `${label} columns`, normalizeColumnKey, (v, w) => parseLine<ColumnProps>(v, w, 'w', COLUMN_KEYS, repairs), repairs),
    rows: parseKeyed(raw.rows, `${label} rows`, normalizeRowKey, (v, w) => parseLine<RowProps>(v, w, 'h', ROW_KEYS, repairs), repairs),
    frozen: parseFrozen(raw.frozen, label, repairs),
    charts: isObject(raw.charts) ? parseKeyed(raw.charts, `${label} charts`, (key) => key, (v, w) => parseChart(v, w, repairs), repairs) : {},
  };
  const extra = extraOf(raw, SHEET_KEYS);
  if (extra) sheet.extra = extra;
  if (raw.charts !== undefined && !isObject(raw.charts)) {
    // Charts are not data: an unreadable list is kept aside and written back until a chart is added.
    addExtra(sheet, 'charts', raw.charts);
    repairs.push(`${label}: "charts" is not an object; it is kept unchanged but not shown.`);
  }
  return sheet;
}

/** Gives every sheet a unique id and a unique, usable name (deterministically: devices must agree). */
function repairSheetIdentity(sheets: Sheet[], repairs: string[]): void {
  const ids = new Set<string>();
  sheets.forEach((s, i) => {
    if (s.id === '' || ids.has(s.id)) {
      let n = i + 1;
      while (ids.has(`s${n}`) || sheets.some((o) => o !== s && o.id === `s${n}`)) n++;
      if (s.id !== '') repairs.push(`Sheet "${s.name}": the id ${quote(s.id)} is used twice; it becomes "s${n}".`);
      s.id = `s${n}`;
    }
    ids.add(s.id);
  });
  const names: string[] = [];
  sheets.forEach((s, i) => {
    const taken = (name: string) => names.some((n) => sameName(n, name));
    if (s.name.trim() === '') {
      let n = i + 1;
      while (taken(`Sheet${n}`) || sheets.some((o) => o !== s && sameName(o.name, `Sheet${n}`))) n++;
      repairs.push(`Sheet ${i + 1} had no name; it is called "Sheet${n}".`);
      s.name = `Sheet${n}`;
    } else if (taken(s.name)) {
      let n = 2;
      while (taken(`${s.name} (${n})`)) n++;
      repairs.push(`Two sheets were called "${s.name}"; the second is renamed "${s.name} (${n})".`);
      s.name = `${s.name} (${n})`;
    }
    names.push(s.name);
  });
}

function parseNamed(raw: Json | undefined, repairs: string[]): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Refusal('"named" is not an object.');
  const named: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      named[name] = value.startsWith('=') ? value.slice(1) : value;
      if (value.startsWith('=')) repairs.push(`Named range "${name}": the leading "=" is dropped.`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      named[name] = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
      repairs.push(`Named range "${name}" is stored as an expression.`);
    } else {
      throw new Refusal(`Named range "${name}" is not an expression.`);
    }
  }
  return named;
}

/**
 * Reads a .sheet file. Malformed files are repaired when that loses nothing (each repair is
 * listed) and refused otherwise; a refused file is left alone for the user to fix as text.
 */
export function parseSheet(text: string): ParseResult {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  if (body.trim() === '') return { ok: true, file: newSheetFile(), repairs: ['The file was empty; it starts as a new workbook.'] };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `This is not valid JSON (${e instanceof Error ? e.message : String(e)}).` };
  }
  const repairs: string[] = [];
  try {
    checkKeys(body);
    if (!isObject(raw)) throw new Refusal('This is not a NotesApp sheet: the file is not a JSON object.');
    if (raw.type !== SHEET_TYPE) throw new Refusal(`This is not a NotesApp sheet: "type" is ${JSON.stringify(raw.type ?? null)}, not "${SHEET_TYPE}".`);
    if (raw.version === undefined) repairs.push(`The format version was missing; it is ${SHEET_VERSION}.`);
    else if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > SHEET_VERSION) {
      throw new Refusal(`This sheet was saved by a newer NotesApp (format version ${raw.version}); update NotesApp to edit it.`);
    } else if (raw.version !== SHEET_VERSION) throw new Refusal(`Unknown format version ${JSON.stringify(raw.version)}.`);
    let engine = '';
    if (typeof raw.engine === 'string') engine = raw.engine;
    else repairs.push('The engine that computed the cached values is unknown; they will be recalculated.');
    if (raw.sheets !== undefined && !Array.isArray(raw.sheets)) throw new Refusal('"sheets" is not a list.');
    const sheets = (raw.sheets ?? []).map((s, i) => parseSheetEntry(s, i, repairs));
    if (sheets.length === 0) {
      repairs.push('The workbook had no sheets; an empty one is added.');
      sheets.push(emptySheet('s1', 'Sheet1'));
    }
    repairSheetIdentity(sheets, repairs);
    const file: SheetFile = { type: SHEET_TYPE, version: SHEET_VERSION, engine, sheets, named: parseNamed(raw.named, repairs) };
    const extra = extraOf(raw, FILE_KEYS);
    if (extra) file.extra = extra;
    return { ok: true, file, repairs };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------- serializing ----------

/** One line of JSON with spaces after `:` and `,`, as in `{ "v": 1, "c": [1, 2] }`. */
function inline(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (isObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${quote(k)}: ${inline(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

/**
 * Known keys in their fixed order, then the kept-aside ones in their original order. A kept-aside
 * value under a known key (an unusable `"w": "wide"`) is written only while the typed field is unset.
 */
function ordered(known: Array<[string, Json | undefined]>, extra: Extra | undefined): Array<[string, Json]> {
  const out = known.filter((e): e is [string, Json] => e[1] !== undefined);
  const written = new Set(out.map(([k]) => k));
  for (const [k, v] of Object.entries(extra ?? {})) if (!written.has(k)) out.push([k, v]);
  return out;
}

const inlineEntries = (entries: Array<[string, Json]>) => (entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${quote(k)}: ${inline(v)}`).join(', ')} }`);

/** A pretty-printed value whose continuation lines are indented to `indent`. */
const block = (value: Json, indent: string) => JSON.stringify(value, null, 2).replace(/\n/g, '\n' + indent);

function keyedBlock<T>(entries: Array<[string, T]>, indent: string, line: (value: T) => string): string {
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${indent}  ${quote(k)}: ${line(v)}`).join(',\n')}\n${indent}}`;
}

const cellLine = (c: SheetCell) => inlineEntries(ordered([['v', c.v], ['f', c.f], ['c', c.c], ['fmt', c.fmt]], c.extra));
const columnLine = (p: ColumnProps) => inlineEntries(ordered([['w', p.w], ['fmt', p.fmt], ['bold', p.bold]], p.extra));
const rowLine = (p: RowProps) => inlineEntries(ordered([['h', p.h], ['fmt', p.fmt], ['bold', p.bold]], p.extra));
const chartLine = (p: ChartProps) =>
  inlineEntries(
    ordered(
      [
        ['type', p.type],
        ['range', p.range],
        ['title', p.title],
        ['headers', p.headers],
        ['labels', p.labels],
      ],
      p.extra,
    ),
  );

/** Plain code-unit order: chart ids, sorted the same way on every device. */
export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const caseless = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

function sheetBlock(sheet: Sheet): string {
  const i = '      ';
  const cells = Object.entries(sheet.cells)
    .filter(([, c]) => !isEmptyCell(c))
    .sort(([a], [b]) => compareA1(a, b));
  const cols = Object.entries(sheet.cols).sort(([a], [b]) => compareColumns(a, b));
  const rows = Object.entries(sheet.rows).sort(([a], [b]) => Number(a) - Number(b));
  const lines = [
    `${i}"id": ${quote(sheet.id)}`,
    `${i}"name": ${quote(sheet.name)}`,
    `${i}"cells": ${keyedBlock(cells, i, cellLine)}`,
    `${i}"cols": ${keyedBlock(cols, i, columnLine)}`,
    `${i}"rows": ${keyedBlock(rows, i, rowLine)}`,
    `${i}"frozen": ${inline({ rows: sheet.frozen.rows, cols: sheet.frozen.cols })}`,
  ];
  const charts = Object.entries(sheet.charts).sort(([a], [b]) => compareIds(a, b));
  // Only when there are any, so files without charts keep the layout of earlier versions.
  if (charts.length > 0) lines.push(`${i}"charts": ${keyedBlock(charts, i, chartLine)}`);
  else if (sheet.extra?.charts !== undefined) lines.push(`${i}"charts": ${block(sheet.extra.charts, i)}`);
  for (const [k, v] of Object.entries(sheet.extra ?? {})) if (!SHEET_KEYS.includes(k)) lines.push(`${i}${quote(k)}: ${block(v, i)}`);
  return `    {\n${lines.join(',\n')}\n    }`;
}

/** Writes the file in its stable layout (see the module comment), ending with a newline. */
export function serializeSheet(file: SheetFile): string {
  const named = Object.entries(file.named).sort(([a], [b]) => caseless(a, b));
  const lines = [
    `  "type": ${quote(SHEET_TYPE)}`,
    `  "version": ${SHEET_VERSION}`,
    `  "engine": ${quote(file.engine)}`,
    `  "sheets": [\n${file.sheets.map(sheetBlock).join(',\n')}\n  ]`,
    `  "named": ${keyedBlock(named, '  ', quote)}`,
  ];
  for (const [k, v] of Object.entries(file.extra ?? {})) if (!FILE_KEYS.includes(k)) lines.push(`  ${quote(k)}: ${block(v, '  ')}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

// ---------- lookups ----------

/**
 * `map[key]` for the map's own keys only. Named ranges, charts and unknown keys are named by users
 * and files, so a key such as `constructor` or `toString` must read as absent when it is not there,
 * not as Object.prototype's function.
 */
export function own<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

export function sheetById(file: SheetFile, id: string): Sheet | undefined {
  return file.sheets.find((s) => s.id === id);
}

export function sheetByName(file: SheetFile, name: string): Sheet | undefined {
  return file.sheets.find((s) => sameName(s.name, name));
}
