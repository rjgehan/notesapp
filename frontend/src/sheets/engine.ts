// The formula engine adapter (ROADMAP item 6, DESIGN §6.21). A Workbook keeps a SheetFile (the
// model, the source of truth) and a HyperFormula instance (a calculator built from it) in step,
// and writes every formula's result into the model's cached `c` values.
//
// Every change is a patch of slot changes (one cell's content, one sheet's name and panes, the
// sheet order, a column, a row, a named range). A patch is applied to the model first; the engine
// is then reconciled with the model's new state. Undo, redo and a remote replace all apply
// patches, so they share one path. The undo history is the workbook's own (HyperFormula's is
// switched off). A large or failed incremental update rebuilds the engine from the model.
//
// This module is a lazy chunk (loadEngine.ts): HyperFormula is about 800 kB minified.
import {
  CellType,
  DetailedCellError,
  ExportedCellChange,
  HyperFormula,
  type CellValue as EngineValue,
  type ConfigParams,
  type ExportedChange,
  type RawCellContent,
  type SimpleCellAddress,
} from 'hyperformula';
import { MAX_COLUMNS, MAX_ROWS, parseA1, toA1 } from './a1';
import {
  emptySheet,
  isEmptyCell,
  newChartId,
  newSheetId,
  nextSheetName,
  sameName,
  serializeSheet,
  sheetById,
  sheetNameProblem,
  type CachedValue,
  type ChartProps,
  type ColumnProps,
  type Extra,
  type Frozen,
  type Json,
  type RowProps,
  type Sheet,
  type SheetCell,
  type SheetFile,
} from './format';

/** The engine identity written to `engine`. A config change that alters results must change it too. */
export const ENGINE_ID = `hyperformula@${HyperFormula.version}`;

/** Edits of more cells than this rebuild the engine, which is faster than as many single updates. */
const REBUILD_THRESHOLD = 1000;
const UNDO_LIMIT = 200;

/**
 * HyperFormula settings. The engine runs under its GPL-3.0 licence (`gpl-v3`; without it every
 * function returns #LIC!). The defaults already match Google Sheets where it matters: 1899-12-30
 * as day 0 without the 1900 leap-year bug, case-insensitive text comparison, wildcards in criteria.
 */
export function engineConfig(): Partial<ConfigParams> {
  return {
    licenseKey: 'gpl-v3',
    undoLimit: 0,
    maxRows: MAX_ROWS,
    maxColumns: MAX_COLUMNS,
    dateFormats: ['YYYY-MM-DD', 'DD/MM/YYYY', 'DD/MM/YY'],
  };
}

// ---------- patches ----------

interface SheetMeta {
  name: string;
  frozen: Frozen;
  extra?: Extra;
}

/** One slot's value before and after; undefined means absent. Cells carry content only, never `c`. */
type Change =
  | { kind: 'sheet'; id: string; before?: SheetMeta; after?: SheetMeta }
  | { kind: 'order'; before: string[]; after: string[] }
  | { kind: 'cell'; id: string; ref: string; before?: SheetCell; after?: SheetCell }
  | { kind: 'col'; id: string; key: string; before?: ColumnProps; after?: ColumnProps }
  | { kind: 'row'; id: string; key: string; before?: RowProps; after?: RowProps }
  | { kind: 'chart'; id: string; key: string; before?: ChartProps; after?: ChartProps }
  | { kind: 'named'; name: string; before?: string; after?: string }
  | { kind: 'extra'; key: string; before?: Json; after?: Json };

type Patch = Change[];

function slotKey(c: Change): string {
  switch (c.kind) {
    case 'sheet':
      return `sheet:${c.id}`;
    case 'order':
      return 'order';
    case 'cell':
      return `cell:${c.id}:${c.ref}`;
    case 'col':
    case 'row':
    case 'chart':
      return `${c.kind}:${c.id}:${c.key}`;
    case 'named':
      return `named:${c.name}`;
    case 'extra':
      return `extra:${c.key}`;
  }
}

function invert(patch: Patch): Patch {
  return patch.map((c) => ({ ...c, before: c.after, after: c.before }) as Change).reverse();
}

function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

const same = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));

/** A cell's content (value, formula, unknown keys) without its cached value; undefined if none. */
function content(cell: SheetCell | undefined): SheetCell | undefined {
  if (!cell) return undefined;
  const { c: _c, ...rest } = cell;
  return isEmptyCell(rest) ? undefined : rest;
}

function meta(s: Sheet): SheetMeta {
  const m: SheetMeta = { name: s.name, frozen: { ...s.frozen } };
  if (s.extra) m.extra = s.extra;
  return m;
}

function diffKeyed<T>(kind: 'col' | 'row' | 'chart', id: string, a: Record<string, T>, b: Record<string, T>, out: Patch): void {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!same(a[key], b[key])) out.push({ kind, id, key, before: a[key], after: b[key] } as Change);
  }
}

/** The patch that turns `a` into `b` (cached values aside). */
function diff(a: SheetFile, b: SheetFile): Patch {
  const out: Patch = [];
  for (const id of new Set([...a.sheets.map((s) => s.id), ...b.sheets.map((s) => s.id)])) {
    const sa = sheetById(a, id);
    const sb = sheetById(b, id);
    const ma = sa && meta(sa);
    const mb = sb && meta(sb);
    if (!same(ma, mb)) out.push({ kind: 'sheet', id, before: ma, after: mb });
    const ca = sa?.cells ?? {};
    const cb = sb?.cells ?? {};
    for (const ref of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      const before = content(ca[ref]);
      const after = content(cb[ref]);
      if (!same(before, after)) out.push({ kind: 'cell', id, ref, before, after });
    }
    diffKeyed('col', id, sa?.cols ?? {}, sb?.cols ?? {}, out);
    diffKeyed('row', id, sa?.rows ?? {}, sb?.rows ?? {}, out);
    diffKeyed('chart', id, sa?.charts ?? {}, sb?.charts ?? {}, out);
  }
  const oa = a.sheets.map((s) => s.id);
  const ob = b.sheets.map((s) => s.id);
  if (oa.join('\n') !== ob.join('\n')) out.push({ kind: 'order', before: oa, after: ob });
  for (const name of new Set([...Object.keys(a.named), ...Object.keys(b.named)])) {
    if (a.named[name] !== b.named[name]) out.push({ kind: 'named', name, before: a.named[name], after: b.named[name] });
  }
  for (const key of new Set([...Object.keys(a.extra ?? {}), ...Object.keys(b.extra ?? {})])) {
    if (!same(a.extra?.[key], b.extra?.[key])) out.push({ kind: 'extra', key, before: a.extra?.[key], after: b.extra?.[key] });
  }
  return out;
}

// ---------- values ----------

/** The engine's input for a cell. Text gets a leading `'`, so the engine never reads it as a number, date or formula. */
function toEngine(cell: SheetCell | undefined): RawCellContent {
  if (!cell) return null;
  if (cell.f !== undefined) return cell.f;
  if (typeof cell.v === 'string') return "'" + cell.v;
  return cell.v ?? null;
}

function fromEngine(value: EngineValue): CachedValue {
  if (value instanceof DetailedCellError) return { e: value.value };
  if (typeof value === 'number' && !Number.isFinite(value)) return { e: '#NUM!' };
  return value;
}

const isSpillError = (c: CachedValue | undefined) => typeof c === 'object' && c !== null && c.e === '#SPILL!';

/** Positions holding only a cached value: array results spilled into cells without content. */
function spillCells(file: SheetFile): Set<string> {
  const out = new Set<string>();
  for (const s of file.sheets) for (const [ref, c] of Object.entries(s.cells)) if (c.c !== undefined && c.v === undefined && c.f === undefined) out.add(`${s.id}!${ref}`);
  return out;
}

/**
 * Whether `file`'s cached values must be rewritten to match `computed`: another engine computed
 * them, a formula has none, or the cells holding spilled array results differ. A changed value
 * alone does not count, so volatile functions (NOW, RAND) never make an opened file dirty.
 */
function cacheStale(file: SheetFile, computed: SheetFile): boolean {
  if (file.engine !== ENGINE_ID) return true;
  for (const s of file.sheets) for (const c of Object.values(s.cells)) if (c.f !== undefined && c.c === undefined) return true;
  const a = spillCells(file);
  const b = spillCells(computed);
  return a.size !== b.size || [...a].some((k) => !b.has(k));
}

// ---------- the workbook ----------

export interface WorkbookChange {
  /** Cells whose content or value changed, by sheet id; null when anything may have changed (a rebuild). */
  cells: Map<string, Set<string>> | null;
  /** Sheets (added, removed, renamed, reordered, frozen panes), columns, rows or named ranges changed. */
  layout: boolean;
  origin: 'edit' | 'undo' | 'redo' | 'replace';
}

export interface CellEdit {
  sheet: string;
  ref: string;
  /** The new value or formula; null clears the cell (its formatting stays). */
  content: Pick<SheetCell, 'v' | 'f'> | null;
  /** A new number format for the cell (null removes it); left out, the cell keeps its own. */
  fmt?: string | null;
}

export interface FormatEdit {
  sheet: string;
  ref: string;
  /** The cell's number format; null removes it (the row's or column's applies again). */
  fmt: string | null;
}

function noteCell(change: WorkbookChange, id: string, ref: string): void {
  if (!change.cells) return;
  const refs = change.cells.get(id) ?? new Set<string>();
  refs.add(ref);
  change.cells.set(id, refs);
}

function mergeChange(into: WorkbookChange, from: WorkbookChange): void {
  into.layout ||= from.layout;
  if (!into.cells || !from.cells) into.cells = null;
  else for (const [id, refs] of from.cells) for (const ref of refs) noteCell(into, id, ref);
}

export class Workbook {
  private model: SheetFile;
  private hf: HyperFormula | null = null;
  /** Our sheet id → the engine's, and back. */
  private engineIds = new Map<string, number>();
  private sheetIds = new Map<number, string>();
  /** Lower-cased name → the model's spelling of the named range the engine holds under it. */
  private engineNames = new Map<string, string>();
  /** Formula cells (`id\nref`) whose array result is blocked (#SPILL!). */
  private spillBlocked = new Set<string>();
  private problemList: string[] = [];
  private undoStack: Patch[] = [];
  private redoStack: Patch[] = [];
  private transaction: { patch: Patch; change: WorkbookChange } | null = null;
  private listeners = new Set<(change: WorkbookChange) => void>();
  private readonly openedStale: boolean;

  /** Loads and calculates a parsed file. The caller's object is not modified. */
  static open(file: SheetFile): Workbook {
    return new Workbook(file);
  }

  private constructor(file: SheetFile) {
    this.model = JSON.parse(JSON.stringify(file)) as SheetFile;
    this.model.engine = ENGINE_ID;
    this.rebuild();
    this.openedStale = cacheStale(file, this.model);
  }

  /**
   * The opened file's cached values had to be rewritten (another engine version computed them,
   * or some were missing). The view saves once, so embeds and search see current values.
   */
  get stale(): boolean {
    return this.openedStale;
  }

  /** The live model. Read it; change it only through the workbook's methods. */
  get file(): SheetFile {
    return this.model;
  }

  /** Content the engine cannot use (an invalid named range), as messages for the user. */
  get problems(): readonly string[] {
    return this.problemList;
  }

  serialize(): string {
    return serializeSheet(this.model);
  }

  cell(sheetId: string, ref: string): SheetCell | undefined {
    return sheetById(this.model, sheetId)?.cells[ref];
  }

  /** The engine's explanation of an error result (for a tooltip), or null. */
  errorMessage(sheetId: string, ref: string): string | null {
    const at = this.address(sheetId, ref);
    const value = at && this.engine.getCellValue(at);
    return value instanceof DetailedCellError ? value.message || value.value : null;
  }

  subscribe(listener: (change: WorkbookChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
    this.hf?.destroy();
    this.hf = null;
  }

  // ---------- edits ----------

  setCell(sheetId: string, ref: string, content: CellEdit['content']): void {
    this.setCells([{ sheet: sheetId, ref, content }]);
  }

  /** Several cells as one undo step (a paste, a fill, clearing a selection). */
  setCells(edits: CellEdit[]): void {
    const patch: Patch = [];
    for (const { sheet: id, ref, content: next, fmt } of edits) {
      const sheet = this.requireSheet(id);
      if (!parseA1(ref)) throw new Error(`Not a cell reference: ${ref}`);
      if (next?.f !== undefined && !next.f.startsWith('=')) throw new Error('A formula starts with "=".');
      if (typeof next?.v === 'number' && !Number.isFinite(next.v)) throw new Error('Not a number.');
      const before = content(sheet.cells[ref]);
      // Formatting and unknown keys stay with the cell; what it held is replaced.
      const kept = Object.entries(before?.extra ?? {}).filter(([k]) => k !== 'v' && k !== 'f' && k !== 'c' && k !== 'fmt');
      const after: SheetCell = {};
      if (next?.f !== undefined) after.f = next.f;
      else if (next?.v !== undefined) after.v = next.v;
      const format = fmt === undefined ? before?.fmt : (fmt ?? undefined);
      if (format !== undefined) after.fmt = format;
      if (kept.length > 0) after.extra = Object.fromEntries(kept);
      const cleaned = content(after);
      if (!same(before, cleaned)) patch.push({ kind: 'cell', id, ref, before, after: cleaned });
    }
    this.record(patch);
  }

  /** Sets or removes the number format of cells, as one undo step; their contents stay. */
  setFormats(edits: FormatEdit[]): void {
    const patch: Patch = [];
    for (const { sheet: id, ref, fmt } of edits) {
      const sheet = this.requireSheet(id);
      if (!parseA1(ref)) throw new Error(`Not a cell reference: ${ref}`);
      const before = content(sheet.cells[ref]);
      const after: SheetCell = { ...before };
      if (fmt === null) delete after.fmt;
      else after.fmt = fmt;
      const cleaned = content(after);
      if (!same(before, cleaned)) patch.push({ kind: 'cell', id, ref, before, after: cleaned });
    }
    this.record(patch);
  }

  /** Adds a chart to a sheet and returns its id. */
  addChart(sheetId: string, props: ChartProps): string {
    const sheet = this.requireSheet(sheetId);
    const key = newChartId(sheet);
    this.record([{ kind: 'chart', id: sheetId, key, after: { ...props } }]);
    return key;
  }

  /** Changes (or, with null, removes) a chart. */
  setChart(sheetId: string, key: string, props: ChartProps | null): void {
    const sheet = this.requireSheet(sheetId);
    const after = props ? { ...props } : undefined;
    if (!same(sheet.charts[key], after)) this.record([{ kind: 'chart', id: sheetId, key, before: sheet.charts[key], after }]);
  }

  /** Adds a sheet after the last one and returns its id. */
  addSheet(name = nextSheetName(this.model)): string {
    const problem = sheetNameProblem(name, this.model);
    if (problem) throw new Error(problem);
    const id = newSheetId(this.model);
    const order = this.model.sheets.map((s) => s.id);
    this.record([
      { kind: 'sheet', id, after: { name, frozen: { rows: 0, cols: 0 } } },
      { kind: 'order', before: order, after: [...order, id] },
    ]);
    return id;
  }

  /** Renames a sheet; formulas that refer to it follow the new name. */
  renameSheet(id: string, name: string): void {
    const sheet = this.requireSheet(id);
    const problem = sheetNameProblem(name, this.model, id);
    if (problem) throw new Error(problem);
    if (sheet.name !== name) this.record([{ kind: 'sheet', id, before: meta(sheet), after: { ...meta(sheet), name } }]);
  }

  /** Removes a sheet with everything in it (undoable); formulas that referred to it show #REF!. */
  removeSheet(id: string): void {
    const sheet = this.requireSheet(id);
    if (this.model.sheets.length === 1) throw new Error('A workbook keeps at least one sheet.');
    const order = this.model.sheets.map((s) => s.id);
    const patch: Patch = [];
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      const before = content(cell);
      if (before) patch.push({ kind: 'cell', id, ref, before });
    }
    for (const [key, before] of Object.entries(sheet.cols)) patch.push({ kind: 'col', id, key, before });
    for (const [key, before] of Object.entries(sheet.rows)) patch.push({ kind: 'row', id, key, before });
    for (const [key, before] of Object.entries(sheet.charts)) patch.push({ kind: 'chart', id, key, before });
    patch.push({ kind: 'sheet', id, before: meta(sheet) }, { kind: 'order', before: order, after: order.filter((x) => x !== id) });
    this.record(patch);
  }

  moveSheet(id: string, index: number): void {
    this.requireSheet(id);
    const order = this.model.sheets.map((s) => s.id);
    const after = order.filter((x) => x !== id);
    after.splice(Math.max(0, Math.min(index, after.length)), 0, id);
    if (after.join('\n') !== order.join('\n')) this.record([{ kind: 'order', before: order, after }]);
  }

  setFrozen(id: string, frozen: Frozen): void {
    const sheet = this.requireSheet(id);
    if (!same(sheet.frozen, frozen)) this.record([{ kind: 'sheet', id, before: meta(sheet), after: { ...meta(sheet), frozen: { ...frozen } } }]);
  }

  setColumn(id: string, key: string, props: ColumnProps | null): void {
    const sheet = this.requireSheet(id);
    const after = props && Object.keys(props).length > 0 ? props : undefined;
    if (!same(sheet.cols[key], after)) this.record([{ kind: 'col', id, key, before: sheet.cols[key], after }]);
  }

  setRow(id: string, key: string, props: RowProps | null): void {
    const sheet = this.requireSheet(id);
    const after = props && Object.keys(props).length > 0 ? props : undefined;
    if (!same(sheet.rows[key], after)) this.record([{ kind: 'row', id, key, before: sheet.rows[key], after }]);
  }

  /** Defines, changes (`expression` without the leading `=`) or removes (null) a named range. */
  setNamed(name: string, expression: string | null): void {
    const existing = Object.keys(this.model.named).find((n) => sameName(n, name));
    const valid = (n: string, e: string) => n !== '__proto__' && this.engine.isItPossibleToAddNamedExpression(n, '=' + e);
    if (expression !== null && existing === undefined && !valid(name, expression)) {
      throw new Error(`"${name}" cannot name a range: use letters, digits and _, and not a cell reference.`);
    }
    // A typed range or value must at least parse (the named-ranges dialog); files are not checked here.
    if (expression !== null && !this.engine.validateFormula('=' + expression)) {
      throw new Error(`"${expression}" is not a range, a value or a formula.`);
    }
    const key = existing ?? name;
    const after = expression ?? undefined;
    if (this.model.named[key] !== after) this.record([{ kind: 'named', name: key, before: this.model.named[key], after }]);
  }

  /** Runs several edits as one undo step, with one change notification. */
  transact(edits: () => void): void {
    if (this.transaction) {
      edits();
      return;
    }
    this.transaction = { patch: [], change: { cells: new Map(), layout: false, origin: 'edit' } };
    try {
      edits();
    } finally {
      const { patch, change } = this.transaction;
      this.transaction = null;
      if (patch.length > 0) {
        this.pushUndo(patch);
        this.emit(change);
      }
    }
  }

  // ---------- undo and redo ----------

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const patch = this.undoStack.pop();
    if (!patch) return false;
    this.emit(this.apply(invert(patch), 'undo'));
    this.redoStack.push(patch);
    return true;
  }

  redo(): boolean {
    const patch = this.redoStack.pop();
    if (!patch) return false;
    this.emit(this.apply(patch, 'redo'));
    this.undoStack.push(patch);
    return true;
  }

  // ---------- remote changes ----------

  /**
   * Makes the workbook equal to `next` (a parsed file from another device, or the other side of
   * a conflict). With `undoable` the change is one undo step (Take theirs). Otherwise it is not
   * undoable, and history touching what it changed is dropped, so an undo can never overwrite
   * another device's edit. `stale` says whether `next`'s cached values need rewriting; a view
   * acts on it only for a change of its own making, so two devices never trade cache-only saves.
   */
  replace(next: SheetFile, opts: { undoable: boolean }): { stale: boolean } {
    const patch = diff(this.model, next);
    if (patch.length > 0) {
      const change = this.apply(patch, 'replace');
      if (opts.undoable) this.pushUndo(patch);
      else this.forgetHistoryTouching(patch);
      this.emit(change);
    }
    return { stale: cacheStale(next, this.model) };
  }

  // ---------- internals ----------

  private get engine(): HyperFormula {
    if (!this.hf) throw new Error('The workbook was destroyed.');
    return this.hf;
  }

  private requireSheet(id: string): Sheet {
    const sheet = sheetById(this.model, id);
    if (!sheet) throw new Error(`No sheet with id ${id}`);
    return sheet;
  }

  private address(id: string, ref: string): SimpleCellAddress | null {
    const sheet = this.engineIds.get(id);
    const at = parseA1(ref);
    return sheet === undefined || !at ? null : { sheet, col: at.col, row: at.row };
  }

  private record(patch: Patch): void {
    if (patch.length === 0) return;
    const change = this.apply(patch, 'edit');
    if (this.transaction) {
      this.transaction.patch.push(...patch);
      mergeChange(this.transaction.change, change);
    } else {
      this.pushUndo(patch);
      this.emit(change);
    }
  }

  private pushUndo(patch: Patch): void {
    this.undoStack.push(patch);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private forgetHistoryTouching(patch: Patch): void {
    // A change anywhere in a sheet touches the sheet as a whole: undoing its creation or removal
    // would carry the other device's edits with it.
    const touched = new Set(patch.map(slotKey));
    for (const c of patch) if ('id' in c) touched.add(`sheet:${c.id}`);
    const overlaps = (p: Patch) => p.some((c) => touched.has(slotKey(c)));
    if (this.undoStack.some(overlaps) || this.redoStack.some(overlaps)) {
      this.undoStack = [];
      this.redoStack = [];
    }
  }

  private emit(change: WorkbookChange): void {
    for (const l of this.listeners) l(change);
  }

  /**
   * Applies a patch to the model, then reconciles the engine with the model's new state. Sheets
   * are added (and renamed) before, and removed after, everything else in the patch, so a patch
   * and its inverse both work whatever order their changes come in.
   */
  private apply(patch: Patch, origin: WorkbookChange['origin']): WorkbookChange {
    const change: WorkbookChange = { cells: new Map(), layout: false, origin };
    const cells = new Map<string, Set<string>>();
    const names = new Set<string>();
    let sheetsChanged = false;
    const sheetChanges = patch.filter((c): c is Extract<Change, { kind: 'sheet' }> => c.kind === 'sheet');

    for (const c of sheetChanges) {
      if (!c.after) continue;
      const sheet = sheetById(this.model, c.id) ?? emptySheet(c.id, c.after.name);
      if (!sheetById(this.model, c.id)) this.model.sheets.push(sheet);
      sheet.name = c.after.name;
      sheet.frozen = { ...c.after.frozen };
      if (c.after.extra) sheet.extra = c.after.extra;
      else delete sheet.extra;
      sheetsChanged = true;
    }
    for (const c of patch) {
      switch (c.kind) {
        case 'sheet':
          break;
        case 'order':
          change.layout = true;
          break;
        case 'cell': {
          const sheet = sheetById(this.model, c.id);
          if (!sheet) break;
          if (c.before?.v === c.after?.v && c.before?.f === c.after?.f) {
            // Only the format (or an unknown key) changed: the engine and the cached value stay.
            const next: SheetCell = { ...c.after };
            const cached = sheet.cells[c.ref]?.c;
            if (cached !== undefined) next.c = cached;
            if (isEmptyCell(next)) delete sheet.cells[c.ref];
            else sheet.cells[c.ref] = next;
            noteCell(change, c.id, c.ref);
            break;
          }
          if (c.after) sheet.cells[c.ref] = { ...c.after };
          else delete sheet.cells[c.ref];
          const refs = cells.get(c.id) ?? new Set<string>();
          refs.add(c.ref);
          cells.set(c.id, refs);
          noteCell(change, c.id, c.ref);
          break;
        }
        case 'col':
        case 'row':
        case 'chart': {
          const sheet = sheetById(this.model, c.id);
          if (!sheet) break;
          const map: Record<string, ColumnProps | RowProps | ChartProps> = c.kind === 'col' ? sheet.cols : c.kind === 'row' ? sheet.rows : sheet.charts;
          if (c.after) map[c.key] = c.after;
          else delete map[c.key];
          change.layout = true;
          break;
        }
        case 'named':
          if (c.after === undefined) delete this.model.named[c.name];
          else this.model.named[c.name] = c.after;
          names.add(c.name);
          change.layout = true;
          break;
        case 'extra':
          if (c.after !== undefined) this.model.extra = { ...this.model.extra, [c.key]: c.after };
          else if (this.model.extra) {
            delete this.model.extra[c.key];
            if (Object.keys(this.model.extra).length === 0) delete this.model.extra;
          }
          break;
      }
    }
    for (const c of sheetChanges) {
      if (c.after) continue;
      this.model.sheets = this.model.sheets.filter((s) => s.id !== c.id);
      sheetsChanged = true;
    }
    if (sheetsChanged) change.layout = true;
    const order = patch.filter((c): c is Extract<Change, { kind: 'order' }> => c.kind === 'order').pop()?.after;
    if (order) {
      const position = new Map(order.map((id, i) => [id, i]));
      this.model.sheets.sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
    }

    if (!sheetsChanged && cells.size === 0 && names.size === 0) return change;
    let size = 0;
    for (const [id, refs] of cells) if (this.engineIds.has(id)) size += refs.size;
    if (size <= REBUILD_THRESHOLD) {
      try {
        this.syncEngine(cells, names, change, origin);
        return change;
      } catch (e) {
        // The model is complete, so the engine can always be rebuilt from it.
        console.error('[notesapp] incremental sheet update failed; rebuilding the engine', e);
      }
    }
    this.rebuild();
    return { ...change, cells: null };
  }

  /** Brings the engine to the model's state for the sheets, cells and names a patch touched. */
  private syncEngine(cells: Map<string, Set<string>>, names: Set<string>, change: WorkbookChange, origin: WorkbookChange['origin']): void {
    const hf = this.engine;
    const inModel = new Set(this.model.sheets.map((s) => s.id));
    const removed = [...this.engineIds.keys()].filter((id) => !inModel.has(id));
    const added = this.model.sheets.filter((s) => !this.engineIds.has(s.id));
    const renamed = this.model.sheets.filter((s) => {
      const engineId = this.engineIds.get(s.id);
      return engineId !== undefined && hf.getSheetName(engineId) !== s.name;
    });
    const updates: Array<[string, string]> = [];
    for (const [id, refs] of cells) if (inModel.has(id) && this.engineIds.has(id)) for (const ref of refs) updates.push([id, ref]);
    this.problemList = this.problemList.filter((p) => ![...names].some((n) => p.includes(`"${n}"`)));

    const exported = hf.batch(() => {
      for (const id of removed) {
        hf.removeSheet(this.engineIds.get(id) as number);
        this.sheetIds.delete(this.engineIds.get(id) as number);
        this.engineIds.delete(id);
      }
      // Through temporary names, so that two sheets can swap names.
      renamed.forEach((s, i) => hf.renameSheet(this.engineIds.get(s.id) as number, `⁣notesapp-rename-${i}`));
      for (const s of renamed) hf.renameSheet(this.engineIds.get(s.id) as number, s.name);
      for (const s of added) this.addEngineSheet(s);
      for (const [id, ref] of updates) hf.setCellContents(this.address(id, ref) as SimpleCellAddress, toEngine(content(this.cell(id, ref))));
      for (const name of names) this.syncNamed(name);
    });
    for (const id of removed) for (const key of [...this.spillBlocked]) if (key.startsWith(id + '\n')) this.spillBlocked.delete(key);
    for (const [id, ref] of updates) this.refreshCell(id, ref);
    for (const s of added) this.recomputeSheet(s);
    this.takeExported(exported, change);
    if (renamed.length > 0) this.followRenames(origin === 'replace' ? 'restore' : 'adopt', change);
    this.retryBlockedSpills(change);
  }

  /** Brings one named range in the engine to the model's state. */
  private syncNamed(name: string): void {
    const hf = this.engine;
    const lower = name.toLowerCase();
    const holder = this.engineNames.get(lower);
    const expression = this.model.named[name];
    if (expression === undefined) {
      if (holder === name) {
        hf.removeNamedExpression(name);
        this.engineNames.delete(lower);
      }
      return;
    }
    if (holder === name) {
      hf.changeNamedExpression(name, '=' + expression);
    } else if (holder === undefined && hf.isItPossibleToAddNamedExpression(name, '=' + expression)) {
      hf.addNamedExpression(name, '=' + expression);
      this.engineNames.set(lower, name);
    } else {
      this.problemList.push(`The named range "${name}" is not valid or is defined twice, and is ignored.`);
    }
  }

  private addEngineSheet(sheet: Sheet): void {
    const hf = this.engine;
    const engineId = hf.getSheetId(hf.addSheet(sheet.name)) as number;
    this.engineIds.set(sheet.id, engineId);
    this.sheetIds.set(engineId, sheet.id);
    // Rows go in blocks (gaps of up to 16 empty rows bridged): far fewer engine calls than one per cell.
    const rows = new Map<number, Array<[number, RawCellContent]>>();
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      const at = parseA1(ref);
      const input = toEngine(content(cell));
      if (!at || input === null) continue;
      const row = rows.get(at.row) ?? [];
      row.push([at.col, input]);
      rows.set(at.row, row);
    }
    const sorted = [...rows.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] - sorted[j] <= 16) j++;
      const block: RawCellContent[][] = [];
      for (let r = sorted[i]; r <= sorted[j]; r++) {
        const line: RawCellContent[] = [];
        for (const [col, input] of rows.get(r) ?? []) {
          while (line.length < col) line.push(null);
          line[col] = input;
        }
        block.push(line);
      }
      hf.setCellContents({ sheet: engineId, col: 0, row: sorted[i] }, block);
      i = j + 1;
    }
  }

  /** Builds the engine from the model and recomputes every cached value. */
  private rebuild(): void {
    this.hf?.destroy();
    const hf = HyperFormula.buildEmpty(engineConfig());
    if (hf.licenseKeyValidityState !== 'valid') throw new Error(`The HyperFormula licence key is ${hf.licenseKeyValidityState}.`);
    this.hf = hf;
    this.engineIds.clear();
    this.sheetIds.clear();
    this.engineNames.clear();
    this.spillBlocked.clear();
    this.problemList = [];
    hf.batch(() => {
      // Formulas use TRUE and FALSE without parentheses, as in Google Sheets and Excel; the engine
      // only knows the functions TRUE() and FALSE(). This also keeps the names from user ranges.
      hf.addNamedExpression('TRUE', '=TRUE()');
      hf.addNamedExpression('FALSE', '=FALSE()');
      for (const sheet of this.model.sheets) this.addEngineSheet(sheet);
      for (const name of Object.keys(this.model.named)) this.syncNamed(name);
    });
    for (const sheet of this.model.sheets) this.recomputeSheet(sheet);
    this.retryBlockedSpills(null);
  }

  /** Every cached value of a sheet the engine has just loaded. */
  private recomputeSheet(sheet: Sheet): void {
    const hf = this.engine;
    let arrays = false;
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (cell.f !== undefined) {
        const at = this.address(sheet.id, ref) as SimpleCellAddress;
        this.cache(sheet.id, ref, cell, hf.getCellValue(at));
        if (hf.getCellType(at) === CellType.ARRAYFORMULA) arrays = true;
      } else if (cell.v !== undefined) {
        delete cell.c;
      } else if (cell.c !== undefined) {
        // A spilled value as the file had it: recomputed below, or gone.
        delete cell.c;
        if (isEmptyCell(cell)) delete sheet.cells[ref];
      }
    }
    if (!arrays) return;
    // Values in cells without content can only come from array formulas spilling into them.
    hf.getSheetValues(this.engineIds.get(sheet.id) as number).forEach((line, row) =>
      line.forEach((value, col) => {
        const ref = toA1(col, row);
        const cell = sheet.cells[ref];
        if (value !== null && cell?.v === undefined && cell?.f === undefined) sheet.cells[ref] = { ...cell, c: fromEngine(value) };
      }),
    );
  }

  private cache(id: string, ref: string, cell: SheetCell, value: EngineValue): void {
    cell.c = fromEngine(value);
    if (isSpillError(cell.c)) this.spillBlocked.add(`${id}\n${ref}`);
    else this.spillBlocked.delete(`${id}\n${ref}`);
  }

  /** The cached value of a cell whose content was just set. */
  private refreshCell(id: string, ref: string): void {
    const cell = this.cell(id, ref);
    if (cell?.f !== undefined) {
      const at = this.address(id, ref);
      if (at) this.cache(id, ref, cell, this.engine.getCellValue(at));
      return;
    }
    this.spillBlocked.delete(`${id}\n${ref}`);
    if (cell?.v !== undefined) delete cell.c;
  }

  /** Values the engine reports as changed: formula results, and array results in cells without content. */
  private takeExported(exported: ExportedChange[], change: WorkbookChange | null): void {
    for (const e of exported) {
      if (!(e instanceof ExportedCellChange)) continue;
      const id = this.sheetIds.get(e.address.sheet);
      const sheet = id === undefined ? undefined : sheetById(this.model, id);
      if (!sheet || id === undefined) continue;
      const ref = toA1(e.address.col, e.address.row);
      const cell = sheet.cells[ref];
      if (cell?.v !== undefined) continue;
      if (cell?.f !== undefined) this.cache(id, ref, cell, e.newValue);
      else if (e.newValue !== null) sheet.cells[ref] = { ...cell, c: fromEngine(e.newValue) };
      else if (cell) {
        delete cell.c;
        if (isEmptyCell(cell)) delete sheet.cells[ref];
      }
      if (change) noteCell(change, id, ref);
    }
  }

  /**
   * After a rename the engine has rewritten the formulas and named ranges that refer to the sheet.
   * `adopt` (an edit, undo or redo) takes the engine's text where it differs in substance, keeping
   * the user's spelling elsewhere; `restore` (a remote replace) puts the model's text back into
   * the engine, because the other device's file is what both must compute.
   */
  private followRenames(mode: 'adopt' | 'restore', change: WorkbookChange): void {
    const hf = this.engine;
    const differs = (mine: string, theirs: string | undefined) => {
      if (theirs === undefined || theirs === mine) return false;
      try {
        return hf.normalizeFormula(mine) !== theirs;
      } catch {
        return true;
      }
    };
    const restore: Array<[SimpleCellAddress, string, string, string]> = [];
    for (const sheet of this.model.sheets) {
      for (const [ref, cell] of Object.entries(sheet.cells)) {
        if (cell.f === undefined) continue;
        const at = this.address(sheet.id, ref) as SimpleCellAddress;
        const current = hf.getCellFormula(at);
        if (!differs(cell.f, current)) continue;
        if (mode === 'adopt') {
          cell.f = current as string;
          noteCell(change, sheet.id, ref);
        } else restore.push([at, cell.f, sheet.id, ref]);
      }
    }
    const namedRestore: Array<[string, string]> = [];
    for (const [name, expression] of Object.entries(this.model.named)) {
      if (this.engineNames.get(name.toLowerCase()) !== name) continue;
      const current = hf.getNamedExpressionFormula(name);
      if (!differs('=' + expression, current)) continue;
      if (mode === 'adopt') this.model.named[name] = (current as string).slice(1);
      else namedRestore.push([name, '=' + expression]);
    }
    if (restore.length === 0 && namedRestore.length === 0) return;
    const exported = hf.batch(() => {
      for (const [at, f] of restore) hf.setCellContents(at, f);
      for (const [name, expression] of namedRestore) hf.changeNamedExpression(name, expression);
    });
    for (const [, , id, ref] of restore) this.refreshCell(id, ref);
    this.takeExported(exported, change);
  }

  /**
   * The engine does not re-expand an array formula once the cell that blocked it is cleared (it
   * keeps #SPILL!). Setting such formulas again lets them spill where they now can.
   */
  private retryBlockedSpills(change: WorkbookChange | null): void {
    if (this.spillBlocked.size === 0) return;
    const blocked = [...this.spillBlocked].map((key) => key.split('\n') as [string, string]);
    const hf = this.engine;
    const exported = hf.batch(() => {
      for (const [id, ref] of blocked) {
        const cell = this.cell(id, ref);
        const at = this.address(id, ref);
        if (cell?.f !== undefined && at) hf.setCellContents(at, cell.f);
      }
    });
    for (const [id, ref] of blocked) this.refreshCell(id, ref);
    this.takeExported(exported, change);
  }
}
