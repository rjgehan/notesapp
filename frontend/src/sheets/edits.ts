// Range operations of the grid (DESIGN §6.21.5): fill, copy, paste and clear, computed as cell
// edits that the Workbook applies as one undo step. Pure and engine-free (the CellEdit type is a
// type-only import), so they are tested without HyperFormula and the grid.
import { MAX_COLUMNS, MAX_ROWS, parseA1, toA1 } from './a1';
import { formatValue } from './display';
import type { CellEdit } from './engine';
import { cellInput, cellValue, type Sheet, type SheetCell } from './format';
import { shiftFormula, type CellRange } from './refs';
import { parseTsv, toTsv } from './tsv';

type Content = CellEdit['content'];

/** What a copy put on the clipboard, kept so a paste in this app brings formulas, not values. */
export interface SheetClip {
  /** The text/plain TSV written to the clipboard; a paste with the same text is this clip. */
  text: string;
  range: CellRange;
  /** Row-major contents of the copied range (null for empty cells). */
  cells: Content[][];
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function contentOf(cell: SheetCell | undefined): Content {
  if (!cell) return null;
  if (cell.f !== undefined) return { f: cell.f };
  if (cell.v !== undefined) return { v: cell.v };
  return null;
}

const sameContent = (a: Content, b: Content) => (a?.f ?? null) === (b?.f ?? null) && (a?.v ?? null) === (b?.v ?? null);

function within(col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < MAX_COLUMNS && row < MAX_ROWS;
}

function inRange(col: number, row: number, r: CellRange): boolean {
  return col >= r.col && col < r.col + r.width && row >= r.row && row < r.row + r.height;
}

/** `content` moved from (row, col) to (row + dRow, col + dCol): formulas shift their references. */
function moved(content: Content, dRow: number, dCol: number): Content {
  if (content?.f !== undefined) return { f: shiftFormula(content.f, dRow, dCol) };
  return content;
}

/** Only the edits that change something, so an unchanged cell never enters the undo history. */
function changed(sheet: Sheet, edits: CellEdit[]): CellEdit[] {
  return edits.filter((e) => !sameContent(contentOf(sheet.cells[e.ref]), e.content));
}

/**
 * Fills `dest` (which contains `source`) by repeating `source` across it, as the fill handle,
 * Fill down and Fill right do: formulas shift their relative references, values are copied, and
 * empty source cells clear their targets.
 */
export function fillEdits(sheet: Sheet, source: CellRange, dest: CellRange): CellEdit[] {
  const edits: CellEdit[] = [];
  for (let row = dest.row; row < dest.row + dest.height; row++) {
    for (let col = dest.col; col < dest.col + dest.width; col++) {
      if (inRange(col, row, source) || !within(col, row)) continue;
      const srcRow = source.row + mod(row - source.row, source.height);
      const srcCol = source.col + mod(col - source.col, source.width);
      const content = contentOf(sheet.cells[toA1(srcCol, srcRow)]);
      edits.push({ sheet: sheet.id, ref: toA1(col, row), content: moved(content, row - srcRow, col - srcCol) });
    }
  }
  return changed(sheet, edits);
}

/**
 * Fill down: the top row of `range` into the rest of it; for a single row, the row above into
 * it (Mod-D in Google Sheets). Fill right is the same along columns.
 */
export function fillDownEdits(sheet: Sheet, range: CellRange): CellEdit[] {
  if (range.height > 1) return fillEdits(sheet, { ...range, height: 1 }, range);
  if (range.row === 0) return [];
  return fillEdits(sheet, { ...range, row: range.row - 1, height: 1 }, { ...range, row: range.row - 1, height: 2 });
}

export function fillRightEdits(sheet: Sheet, range: CellRange): CellEdit[] {
  if (range.width > 1) return fillEdits(sheet, { ...range, width: 1 }, range);
  if (range.col === 0) return [];
  return fillEdits(sheet, { ...range, col: range.col - 1, width: 1 }, { ...range, col: range.col - 1, width: 2 });
}

/** Clears every cell of `range` that holds something (formatting and unknown keys stay). */
export function clearEdits(sheet: Sheet, range: CellRange): CellEdit[] {
  const edits: CellEdit[] = [];
  // A large range (a whole column) is cleared from the cells that exist, not cell by cell.
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    // A value an array formula spilled into belongs to that formula.
    if (cell.v === undefined && cell.f === undefined) continue;
    const at = parseA1(ref);
    if (at && inRange(at.col, at.row, range)) edits.push({ sheet: sheet.id, ref, content: null });
  }
  return edits;
}

/** The last used row and column of a sheet (-1 when empty). */
export function usedExtent(sheet: Sheet): { rows: number; cols: number } {
  let rows = -1;
  let cols = -1;
  for (const ref of Object.keys(sheet.cells)) {
    const at = parseA1(ref);
    if (!at) continue;
    if (at.row > rows) rows = at.row;
    if (at.col > cols) cols = at.col;
  }
  return { rows, cols };
}

/**
 * The copy of `range`: TSV of the values as shown (for other programs) and the contents (for
 * this app). A selection reaching past the used cells (a whole column) is cut to them.
 */
export function copyRange(sheet: Sheet, selection: CellRange): SheetClip {
  const used = usedExtent(sheet);
  const range: CellRange = {
    ...selection,
    width: Math.max(1, Math.min(selection.width, used.cols - selection.col + 1)),
    height: Math.max(1, Math.min(selection.height, used.rows - selection.row + 1)),
  };
  const shown: string[][] = [];
  const cells: Content[][] = [];
  for (let row = range.row; row < range.row + range.height; row++) {
    const texts: string[] = [];
    const contents: Content[] = [];
    for (let col = range.col; col < range.col + range.width; col++) {
      const cell = sheet.cells[toA1(col, row)];
      texts.push(formatValue(cellValue(cell)));
      contents.push(contentOf(cell));
    }
    shown.push(texts);
    cells.push(contents);
  }
  return { text: toTsv(shown), range, cells };
}

/**
 * The edits a paste of `text` at `target` makes. A paste of this app's own copy (`clip`, same
 * text) brings its formulas, shifted to the new place; any other text is read as typed input,
 * cell by cell. When `target` is a larger range that the pasted block divides evenly, the block is
 * repeated across it, as Google Sheets does.
 */
export function pasteEdits(sheet: Sheet, target: CellRange, text: string, clip: SheetClip | null): { edits: CellEdit[]; range: CellRange } {
  const own = clip !== null && clip.text === text;
  const block: Content[][] = own ? clip.cells : parseTsv(text).map((r) => r.map(cellInput));
  const height = block.length;
  const width = Math.max(0, ...block.map((r) => r.length));
  if (height === 0 || width === 0) return { edits: [], range: { ...target, width: 1, height: 1 } };
  const tile = target.width % width === 0 && target.height % height === 0;
  const range: CellRange = {
    col: target.col,
    row: target.row,
    width: tile ? target.width : width,
    height: tile ? target.height : height,
  };
  const edits: CellEdit[] = [];
  for (let row = range.row; row < range.row + range.height; row++) {
    for (let col = range.col; col < range.col + range.width; col++) {
      if (!within(col, row)) continue;
      const i = (row - range.row) % height;
      const j = (col - range.col) % width;
      let content = block[i][j] ?? null;
      if (own) content = moved(content, row - (clip.range.row + i), col - (clip.range.col + j));
      edits.push({ sheet: sheet.id, ref: toA1(col, row), content });
    }
  }
  return { edits: changed(sheet, edits), range };
}
