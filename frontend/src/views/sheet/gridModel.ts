// Between the sheet model and Glide Data Grid (DESIGN §6.21.6): the grid's size, columns, frozen
// rows, cell contents and selections. Glide has frozen columns but no frozen top rows, so frozen
// rows are drawn in its (sticky) header below the column letters: the grid's own rows start at
// sheet row `frozenRows`. Sheet coordinates are 0-based column and row; grid rows are offset by
// the frozen rows.
import { CompactSelection, GridCellKind, type GridCell, type GridColumn, type GridSelection, type Theme } from '@glideapps/glide-data-grid';
import { columnLetters, MAX_COLUMNS, MAX_ROWS, toA1 } from '../../sheets/a1';
import { formatValue, valueAlign } from '../../sheets/display';
import { usedExtent } from '../../sheets/edits';
import { cellText, cellValue, isCellError, type Sheet } from '../../sheets/format';
import type { CellRange } from '../../sheets/refs';

/** Height of the column letters above the frozen rows. */
export const HEADER_BAND = 26;
export const DEFAULT_COLUMN_WIDTH = 100;
export const MIN_COLUMN_WIDTH = 32;
export const MAX_COLUMN_WIDTH = 800;
/** A new or small sheet still shows a sheet-sized grid, as Google Sheets does. */
const MIN_ROWS = 1000;
const MIN_COLUMNS = 26;
/** Room below and right of the used cells. */
const ROW_MARGIN = 100;
const COLUMN_MARGIN = 4;

export interface CellAt {
  col: number;
  row: number;
}

export interface SheetSelection {
  active: CellAt;
  range: CellRange;
}

export interface GridLayout {
  /** Rows and columns the grid shows, frozen ones included (sheet coordinates). */
  rows: number;
  cols: number;
  /** Frozen rows drawn in the header, possibly fewer than the file asks for when they would not fit. */
  frozenRows: number;
  frozenCols: number;
  frozenHeight: number;
  rowHeight(sheetRow: number): number;
  columnWidth(col: number): number;
}

export interface LayoutOptions {
  rowHeight: number;
  /** Rows and columns the user scrolled or moved into beyond the default size. */
  minRows: number;
  minCols: number;
  /** Frozen rows beyond this height stay in the grid (a phone in landscape). */
  maxFrozenHeight: number;
}

export function gridLayout(sheet: Sheet, opts: LayoutOptions): GridLayout {
  const used = usedExtent(sheet);
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, used.rows + 1 + ROW_MARGIN, opts.minRows, sheet.frozen.rows + 1));
  const cols = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, used.cols + 1 + COLUMN_MARGIN, opts.minCols, sheet.frozen.cols + 1));
  const rowHeight = (row: number) => sheet.rows[String(row + 1)]?.h ?? opts.rowHeight;
  const columnWidth = (col: number) => {
    const w = sheet.cols[columnLetters(col)]?.w;
    return w === undefined ? DEFAULT_COLUMN_WIDTH : Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w));
  };
  let frozenRows = 0;
  let frozenHeight = 0;
  while (frozenRows < sheet.frozen.rows && frozenRows < rows - 1) {
    const next = frozenHeight + rowHeight(frozenRows);
    if (frozenRows > 0 && next > opts.maxFrozenHeight) break;
    frozenHeight = next;
    frozenRows++;
  }
  return { rows, cols, frozenRows, frozenCols: Math.min(sheet.frozen.cols, cols - 1), frozenHeight, rowHeight, columnWidth };
}

/** The frozen row at `y` pixels below the column letters, or null below the frozen rows. */
export function frozenRowAt(layout: GridLayout, y: number): number | null {
  if (y < 0) return null;
  let top = 0;
  for (let r = 0; r < layout.frozenRows; r++) {
    top += layout.rowHeight(r);
    if (y < top) return r;
  }
  return null;
}

/** The top of frozen row `row`, in pixels below the column letters. */
export function frozenRowTop(layout: GridLayout, row: number): number {
  let top = 0;
  for (let r = 0; r < row; r++) top += layout.rowHeight(r);
  return top;
}

export function gridColumns(sheet: Sheet, layout: GridLayout, sizing: ReadonlyMap<number, number>, theme: { fontSize: number }): GridColumn[] {
  const columns: GridColumn[] = [];
  for (let col = 0; col < layout.cols; col++) {
    const letters = columnLetters(col);
    const bold = sheet.cols[letters]?.bold === true;
    columns.push({
      id: letters,
      title: letters,
      width: sizing.get(col) ?? layout.columnWidth(col),
      ...(bold ? { themeOverride: { baseFontStyle: `700 ${theme.fontSize}px` } } : {}),
    });
  }
  return columns;
}

export interface CellOptions {
  /** Glide's own overlay editor opens on the cell (desktop); otherwise the formula bar edits it. */
  overlay: boolean;
  readonly: boolean;
  errorColor: string;
}

/** What the grid shows and edits for a cell: its value as text, and its formula or value to edit. */
export function gridCell(sheet: Sheet, col: number, row: number, opts: CellOptions): GridCell {
  const cell = sheet.cells[toA1(col, row)];
  const value = cellValue(cell);
  const shown = formatValue(value);
  const error = isCellError(value);
  const themeOverride: Partial<Theme> | undefined = error ? { textDark: opts.errorColor } : undefined;
  return {
    kind: GridCellKind.Text,
    data: cellText(cell),
    displayData: shown,
    allowOverlay: opts.overlay,
    readonly: opts.readonly,
    contentAlign: valueAlign(value),
    copyData: shown,
    ...(themeOverride ? { themeOverride } : {}),
  };
}

// ---------- selections ----------

export const NO_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

/** A sheet selection from Glide's: a column or row selected from its header becomes a range. */
export function fromGridSelection(sel: GridSelection, layout: GridLayout): SheetSelection | null {
  const f = layout.frozenRows;
  if (sel.current) {
    const [col, row] = sel.current.cell;
    const r = sel.current.range;
    return { active: { col, row: row + f }, range: { col: r.x, row: r.y + f, width: r.width, height: r.height } };
  }
  const columns = sel.columns;
  if (columns.length > 0) {
    const first = columns.first() ?? 0;
    const last = columns.last() ?? first;
    return { active: { col: first, row: 0 }, range: { col: first, row: 0, width: last - first + 1, height: layout.rows } };
  }
  const rows = sel.rows;
  if (rows.length > 0) {
    const first = rows.first() ?? 0;
    const last = rows.last() ?? first;
    return { active: { col: 0, row: first + f }, range: { col: 0, row: first + f, width: layout.cols, height: last - first + 1 } };
  }
  return null;
}

/** Glide's selection for a sheet selection; empty when the active cell is a frozen one. */
export function toGridSelection(s: SheetSelection, layout: GridLayout): GridSelection {
  const f = layout.frozenRows;
  if (s.active.row < f) return NO_SELECTION;
  const top = Math.max(s.range.row, f);
  const height = Math.max(1, s.range.row + s.range.height - top);
  return {
    current: {
      cell: [s.active.col, s.active.row - f],
      range: { x: s.range.col, y: top - f, width: s.range.width, height },
      rangeStack: [],
    },
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  };
}

/** A selection of one cell. */
export function cellSelection(col: number, row: number): SheetSelection {
  return { active: { col, row }, range: { col, row, width: 1, height: 1 } };
}

/** `sel` kept inside the grid's rows and columns (after a sheet shrank or another sheet opened). */
export function clampSelection(sel: SheetSelection, layout: GridLayout): SheetSelection {
  const col = Math.min(sel.active.col, layout.cols - 1);
  const row = Math.min(sel.active.row, layout.rows - 1);
  if (col === sel.active.col && row === sel.active.row && sel.range.col + sel.range.width <= layout.cols && sel.range.row + sel.range.height <= layout.rows) return sel;
  return cellSelection(col, row);
}
