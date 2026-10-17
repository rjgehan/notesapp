// Cell-level 3-way merge of .sheet files, for the sheet view descriptor's merge() (DESIGN §6.8,
// §6.21). A conflict reaches the banner only when the same thing changed differently on both
// sides: a cell's content or format, a sheet's name or frozen panes, a column, a row, a chart or a
// named range.
// Cached values (`c`) are not content: they are taken from a side whose calculation inputs equal
// the merged ones, or else the result's `engine` is cleared so the next engine run recalculates.
import {
  emptySheet,
  isEmptyCell,
  parseSheet,
  sameName,
  serializeSheet,
  type Json,
  type Sheet,
  type SheetCell,
  type SheetFile,
} from './format';

const CONFLICT = Symbol('conflict');
type Conflict = typeof CONFLICT;

/** JSON with object keys sorted, for comparing values that may have been written in any key order. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const same = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));

/** The classic rule: equal sides agree; otherwise the side that differs from the base wins. */
function merge3<T>(base: T | undefined, mine: T | undefined, theirs: T | undefined): T | undefined | Conflict {
  if (same(mine, theirs)) return mine;
  if (same(base, mine)) return theirs;
  if (same(base, theirs)) return mine;
  return CONFLICT;
}

function mergeKeyed<T>(base: Record<string, T>, mine: Record<string, T>, theirs: Record<string, T>): Record<string, T> | Conflict {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const merged = merge3(base[key], mine[key], theirs[key]);
    if (merged === CONFLICT) return CONFLICT;
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

/** A cell's content without its cached value; undefined for a cell that only holds a cache. */
function content(cell: SheetCell): SheetCell | undefined {
  const { c: _c, ...rest } = cell;
  return isEmptyCell(rest) ? undefined : rest;
}

function contents(cells: Record<string, SheetCell>): Record<string, SheetCell> {
  const out: Record<string, SheetCell> = {};
  for (const [ref, cell] of Object.entries(cells)) {
    const c = content(cell);
    if (c) out[ref] = c;
  }
  return out;
}

/** Everything about a sheet that a merge compares (its cached values excluded). */
const sheetContent = (s: Sheet) => ({
  name: s.name,
  cells: contents(s.cells),
  cols: s.cols,
  rows: s.rows,
  frozen: s.frozen,
  charts: s.charts,
  extra: s.extra ?? {},
});

/**
 * Cells merge per part: the content (value or formula), the number format and each unknown key,
 * so a format set on one device and a value typed on the other are both kept.
 */
function mergeCells(base: Record<string, SheetCell>, mine: Record<string, SheetCell>, theirs: Record<string, SheetCell>): Record<string, SheetCell> | Conflict {
  const out: Record<string, SheetCell> = {};
  for (const ref of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const [b, m, t] = [base[ref], mine[ref], theirs[ref]];
    const whole = merge3(b, m, t);
    if (whole !== CONFLICT) {
      if (whole !== undefined) out[ref] = whole;
      continue;
    }
    const value = (c: SheetCell | undefined) => (c?.v !== undefined ? { v: c.v } : c?.f !== undefined ? { f: c.f } : undefined);
    const content = merge3(value(b), value(m), value(t));
    const fmt = merge3(b?.fmt, m?.fmt, t?.fmt);
    const extra = mergeKeyed(b?.extra ?? {}, m?.extra ?? {}, t?.extra ?? {});
    if (content === CONFLICT || fmt === CONFLICT || extra === CONFLICT) return CONFLICT;
    const cell: SheetCell = { ...content };
    if (fmt !== undefined) cell.fmt = fmt;
    if (Object.keys(extra).length > 0) cell.extra = extra;
    if (!isEmptyCell(cell)) out[ref] = cell;
  }
  return out;
}

function mergeSheet(base: Sheet, mine: Sheet, theirs: Sheet): Sheet | Conflict {
  const [b, m, t] = [base, mine, theirs].map(sheetContent);
  const name = merge3(b.name, m.name, t.name);
  const frozen = merge3(b.frozen, m.frozen, t.frozen);
  const cells = mergeCells(b.cells, m.cells, t.cells);
  const cols = mergeKeyed(b.cols, m.cols, t.cols);
  const rows = mergeKeyed(b.rows, m.rows, t.rows);
  const charts = mergeKeyed(b.charts, m.charts, t.charts);
  const extra = mergeKeyed(b.extra, m.extra, t.extra);
  if (name === CONFLICT || frozen === CONFLICT || cells === CONFLICT || cols === CONFLICT || rows === CONFLICT || charts === CONFLICT || extra === CONFLICT) {
    return CONFLICT;
  }
  const sheet: Sheet = { id: mine.id, name: name ?? mine.name, cells, cols, rows, frozen: frozen ?? mine.frozen, charts };
  if (Object.keys(extra).length > 0) sheet.extra = extra as Record<string, Json>;
  return sheet;
}

const ids = (sheets: Sheet[], keep: Set<string>) => sheets.map((s) => s.id).filter((id) => keep.has(id));

/**
 * The merged sheet order. The side that reordered the sheets both had wins; reorders on both
 * sides that disagree are a conflict. Sheets new on the other side keep their place after the
 * sheet they followed there.
 */
function mergeOrder(base: Sheet[], mine: Sheet[], theirs: Sheet[], result: Set<string>): string[] | Conflict {
  const original = new Set(base.map((s) => s.id).filter((id) => result.has(id)));
  const [b, m, t] = [base, mine, theirs].map((sheets) => ids(sheets, original).join('\n'));
  let primary: Sheet[];
  let other: Sheet[];
  if (m === b) [primary, other] = [theirs, mine];
  else if (t === b || t === m) [primary, other] = [mine, theirs];
  else return CONFLICT;
  const order = ids(primary, result);
  const otherOrder = ids(other, result);
  otherOrder.forEach((id, i) => {
    if (order.includes(id)) return;
    const after = i > 0 ? order.indexOf(otherOrder[i - 1]) : -1;
    order.splice(after + 1, 0, id);
  });
  return order;
}

/** What formulas see: sheet names with their cell contents, and the named ranges. */
function calcInputs(file: SheetFile): string {
  const sheets = file.sheets
    .map((s) => {
      const cells = Object.entries(s.cells).flatMap(([ref, c]) => (c.v === undefined && c.f === undefined ? [] : [[ref, c.v ?? null, c.f ?? null] as const]));
      return [s.name.toLowerCase(), cells.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return canon({ sheets, named: file.named });
}

/** Copies the cached values of `source`, whose calculation inputs equal the result's. */
function takeCache(result: SheetFile, source: SheetFile): void {
  for (const sheet of result.sheets) {
    const from = source.sheets.find((s) => s.id === sheet.id);
    if (!from) continue;
    for (const [ref, cell] of Object.entries(from.cells)) {
      if (cell.c === undefined) continue;
      const target = sheet.cells[ref];
      if (target?.f !== undefined) target.c = cell.c;
      else if (cell.v === undefined && cell.f === undefined && target?.v === undefined) sheet.cells[ref] = { ...target, c: cell.c };
    }
  }
  result.engine = source.engine;
}

/** Keeps the best cached values at hand; the cleared `engine` makes the next engine run recalculate. */
function staleCache(result: SheetFile, mine: SheetFile, theirs: SheetFile): void {
  for (const sheet of result.sheets) {
    const sides = [mine, theirs].map((f) => f.sheets.find((s) => s.id === sheet.id));
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (cell.f === undefined) continue;
      const from = sides.find((s) => s?.cells[ref]?.f === cell.f && s?.cells[ref]?.c !== undefined);
      if (from) cell.c = from.cells[ref]?.c;
    }
    // Array results spilling into empty cells, as this device last computed them.
    for (const [ref, cell] of Object.entries(sides[0]?.cells ?? {})) {
      if (cell.c !== undefined && cell.v === undefined && cell.f === undefined && !sheet.cells[ref]) sheet.cells[ref] = { c: cell.c };
    }
  }
  result.engine = '';
}

/** The 3-way merge of parsed files, or null when both sides changed the same thing differently. */
export function mergeSheetFiles(base: SheetFile, mine: SheetFile, theirs: SheetFile): SheetFile | null {
  const byId = (file: SheetFile) => new Map(file.sheets.map((s) => [s.id, s]));
  const [b, m, t] = [base, mine, theirs].map(byId);
  const merged = new Map<string, Sheet>();
  for (const id of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const [bs, ms, ts] = [b.get(id), m.get(id), t.get(id)];
    if (ms && ts) {
      const sheet = mergeSheet(bs ?? emptySheet(id, ''), ms, ts);
      if (sheet === CONFLICT) return null;
      merged.set(id, sheet);
    } else if (ms || ts) {
      const kept = (ms ?? ts) as Sheet;
      // New on one side; or deleted on the other, which wins only if this side left it alone.
      if (bs && !same(sheetContent(bs), sheetContent(kept))) return null;
      if (!bs) merged.set(id, { ...kept, cells: contents(kept.cells) });
    }
  }
  const order = mergeOrder(base.sheets, mine.sheets, theirs.sheets, new Set(merged.keys()));
  const named = mergeKeyed(base.named, mine.named, theirs.named);
  const extra = mergeKeyed(base.extra ?? {}, mine.extra ?? {}, theirs.extra ?? {});
  if (order === CONFLICT || named === CONFLICT || extra === CONFLICT) return null;
  const sheets = order.map((id) => merged.get(id) as Sheet);
  // Two sides may each have added a sheet or a name that only differs in case.
  const sheetNames = sheets.map((s) => s.name);
  if (sheetNames.some((n, i) => sheetNames.findIndex((x) => sameName(x, n)) !== i)) return null;
  const names = Object.keys(named);
  if (names.some((n, i) => names.findIndex((x) => sameName(x, n)) !== i)) return null;
  if (sheets.length === 0) return null;

  const result: SheetFile = { type: mine.type, version: mine.version, engine: '', sheets, named };
  if (Object.keys(extra).length > 0) result.extra = extra;
  const inputs = calcInputs(result);
  if (inputs === calcInputs(mine)) takeCache(result, mine);
  else if (inputs === calcInputs(theirs)) takeCache(result, theirs);
  else staleCache(result, mine, theirs);
  return result;
}

/**
 * The view descriptor's merge(base, mine, theirs) for .sheet text. Returns one side's text
 * unchanged when the merge equals it, the merged file otherwise, and null (the conflict banner)
 * when a side cannot be read or both changed the same cell.
 */
export function mergeSheetText(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs) return mine;
  const [b, m, t] = [base, mine, theirs].map(parseSheet);
  if (!b.ok || !m.ok || !t.ok) return null;
  const [bText, mText, tText] = [b.file, m.file, t.file].map(serializeSheet);
  if (mText === tText) return mine;
  if (bText === mText) return theirs;
  if (bText === tText) return mine;
  const merged = mergeSheetFiles(b.file, m.file, t.file);
  if (!merged) return null;
  const text = serializeSheet(merged);
  return text === mText ? mine : text === tText ? theirs : text;
}
