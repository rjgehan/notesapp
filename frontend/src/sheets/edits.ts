// Range operations of the grid (DESIGN §6.21.5): fill, copy, paste and clear, computed as cell
// edits that the Workbook applies as one undo step. Fill and pastes of this app's own copies bring
// the cells' number formats along; values typed or pasted as text bring the format they imply
// (`10%`) into cells without one (§6.21.8). Pure and engine-free (the CellEdit type is a type-only
// import), so they are tested without HyperFormula and the grid.
import { MAX_COLUMNS, MAX_ROWS, parseA1, toA1 } from './a1';
import { effectiveFormat, shownCell } from './display';
import type { CellEdit } from './engine';
import { isCellError, type Sheet, type SheetCell } from './format';
import { typedInput } from './input';
import { isGeneral } from './numfmt';
import { shiftFormula, type CellRange } from './refs';
import { numberSeries, seriesValue } from './series';
import { parseTsv, toTsv } from './tsv';

type Content = CellEdit['content'];

/** What a copy put on the clipboard, kept so a paste in this app brings formulas, not values. */
export interface SheetClip {
  /** The text/plain TSV written to the clipboard; a paste with the same text is this clip. */
  text: string;
  range: CellRange;
  /** Row-major contents of the copied range (null for empty cells). */
  cells: Content[][];
  /** The copied cells' own number formats. */
  formats?: Array<Array<string | undefined>>;
  /**
   * Set for a cut: the workbook (`source`, its path) and sheet it came from. Pasting it in that
   * workbook moves the cells (Workbook.moveCells) while they still hold what was cut.
   */
  cut?: { source: string; sheet: string };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function contentOf(cell: SheetCell | undefined): Content {
  if (!cell) return null;
  if (cell.f !== undefined) return { f: cell.f };
  if (cell.v !== undefined) return { v: cell.v };
  return null;
}

/**
 * What a copy or fill takes from a cell: its formula or value, and for a cell that only shows what
 * an array formula spilled into it, that value (an error as its text), so it pastes as it shows.
 */
export function copiedContent(cell: SheetCell | undefined): Content {
  if (cell?.f === undefined && cell?.v === undefined && cell?.c !== undefined && cell.c !== null) return { v: isCellError(cell.c) ? cell.c.e : cell.c };
  return contentOf(cell);
}

export const sameContent = (a: Content, b: Content) => (a?.f ?? null) === (b?.f ?? null) && (a?.v ?? null) === (b?.v ?? null);

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
  return edits.filter((e) => {
    const cell = sheet.cells[e.ref];
    return !sameContent(contentOf(cell), e.content) || (e.fmt !== undefined && (e.fmt ?? undefined) !== cell?.fmt);
  });
}

/** `edit` with the cell format `fmt` (undefined: none), when the target cell's own format differs. */
function withFormat(sheet: Sheet, edit: CellEdit, fmt: string | undefined): CellEdit {
  return fmt === sheet.cells[edit.ref]?.fmt ? edit : { ...edit, fmt: fmt ?? null };
}

/**
 * What typing or pasting `text` into a cell makes of it: the format the text implies (`10%`) is
 * set when no format applies to the cell yet, and a plain-text cell (`@`) takes the text as it is.
 */
export function typedEdit(sheet: Sheet, col: number, row: number, text: string): CellEdit {
  const fmt = effectiveFormat(sheet, col, row);
  const typed = typedInput(text, { plainText: fmt === '@' });
  const edit: CellEdit = { sheet: sheet.id, ref: toA1(col, row), content: typed.content };
  if (typed.fmt !== undefined && isGeneral(fmt)) edit.fmt = typed.fmt;
  return edit;
}

/**
 * Fills `dest` (which contains `source`) by repeating `source` across it, as the fill handle,
 * Fill down and Fill right do: formulas shift their relative references, values are copied (numbers that step evenly continue
 * as a series), and empty source cells clear their targets.
 */
export function fillEdits(sheet: Sheet, source: CellRange, dest: CellRange): CellEdit[] {
  const edits: CellEdit[] = [];
  // Numbers that step evenly along the fill continue as a series (1, 2 → 3, 4), as in Google Sheets.
  const down = dest.height > source.height;
  const across = !down && dest.width > source.width;
  const seriesOf = new Map<number, ReturnType<typeof numberSeries>>();
  const series = (line: number) => {
    if (!seriesOf.has(line)) {
      const values: Array<number | null> = [];
      const length = down ? source.height : source.width;
      for (let i = 0; i < length; i++) {
        const cell = sheet.cells[down ? toA1(line, source.row + i) : toA1(source.col + i, line)];
        values.push(cell?.f === undefined && typeof cell?.v === 'number' ? cell.v : null);
      }
      seriesOf.set(line, down || across ? numberSeries(values) : null);
    }
    return seriesOf.get(line)!;
  };
  for (let row = dest.row; row < dest.row + dest.height; row++) {
    for (let col = dest.col; col < dest.col + dest.width; col++) {
      if (inRange(col, row, source) || !within(col, row)) continue;
      const srcRow = source.row + mod(row - source.row, source.height);
      const srcCol = source.col + mod(col - source.col, source.width);
      const from = sheet.cells[toA1(srcCol, srcRow)];
      const run = series(down ? col : row);
      const content = run ? { v: seriesValue(run, down ? row - source.row : col - source.col) } : moved(copiedContent(from), row - srcRow, col - srcCol);
      const edit = { sheet: sheet.id, ref: toA1(col, row), content };
      edits.push(withFormat(sheet, edit, from?.fmt));
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

/**
 * The last used row and column of a sheet (-1 when empty). With `values`, only cells that show
 * something count, not cells that only hold a format.
 */
export function usedExtent(sheet: Sheet, opts: { values?: boolean } = {}): { rows: number; cols: number } {
  let rows = -1;
  let cols = -1;
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    if (opts.values && cell.v === undefined && cell.f === undefined && cell.c === undefined) continue;
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
  const formats: Array<Array<string | undefined>> = [];
  for (let row = range.row; row < range.row + range.height; row++) {
    const texts: string[] = [];
    const contents: Content[] = [];
    const fmts: Array<string | undefined> = [];
    for (let col = range.col; col < range.col + range.width; col++) {
      const cell = sheet.cells[toA1(col, row)];
      texts.push(shownCell(sheet, col, row).text);
      contents.push(copiedContent(cell));
      fmts.push(cell?.fmt);
    }
    shown.push(texts);
    cells.push(contents);
    formats.push(fmts);
  }
  return { text: toTsv(shown), range, cells, formats };
}

/** Whether the copied range of `sheet` still holds what `clip` took from it (a cut moves only then). */
export function clipStillHolds(sheet: Sheet, clip: SheetClip): boolean {
  const r = clip.range;
  for (let i = 0; i < r.height; i++) {
    for (let j = 0; j < r.width; j++) {
      const cell = sheet.cells[toA1(r.col + j, r.row + i)];
      if (!sameContent(copiedContent(cell), clip.cells[i]?.[j] ?? null) || cell?.fmt !== clip.formats?.[i]?.[j]) return false;
    }
  }
  return true;
}

/**
 * The edits a paste of `text` at `target` makes. A paste of this app's own copy (`clip`, same
 * text) brings its formulas, shifted to the new place; any other text is read as typed input,
 * cell by cell. When `target` is a larger range that the pasted block divides evenly, the block is
 * repeated across it, as Google Sheets does.
 */
export function pasteEdits(sheet: Sheet, target: CellRange, text: string, clip: SheetClip | null): { edits: CellEdit[]; range: CellRange } {
  const own = clip !== null && clip.text === text;
  const block: Array<Array<Content | string>> = own ? clip.cells : parseTsv(text);
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
      const item = block[i][j] ?? null;
      if (own) {
        const content = moved(item as Content, row - (clip.range.row + i), col - (clip.range.col + j));
        const edit = { sheet: sheet.id, ref: toA1(col, row), content };
        edits.push(clip.formats ? withFormat(sheet, edit, clip.formats[i]?.[j]) : edit);
      } else edits.push(typedEdit(sheet, col, row, (item as string | null) ?? ''));
    }
  }
  return { edits: changed(sheet, edits), range };
}
