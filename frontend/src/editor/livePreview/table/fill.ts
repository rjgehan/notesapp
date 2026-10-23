// Fill in a note's table (DESIGN §6.6.1, §6.42), as the spreadsheet view fills (sheets/edits.ts):
// the fill handle and Mod-D / Mod-R repeat the source cells across the destination; a formula's
// relative references follow it (`=B2*2` one row down is `=B3*2`), absolute ones (`$B$2`) stay;
// plain numbers that step evenly continue as a series (1, 2 → 3, 4); other text is copied. Pure.
import { isFormula } from '../../../formulas/model';
import { shiftFormula } from '../../../sheets/refs';
import { numberSeries, seriesValue } from '../../../sheets/series';

/** A rectangle of a table's cells; row 0 is the header. */
export interface CellRect {
  row: number;
  column: number;
  height: number;
  width: number;
}

const NUMBER = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The cells of `dest` (which contains `source`) outside `source`, with what the fill writes in them. */
export function fillCells(rows: readonly (readonly string[])[], source: CellRect, dest: CellRect): Array<{ row: number; column: number; text: string }> {
  const at = (r: number, c: number) => rows[r]?.[c] ?? '';
  const down = dest.height > source.height;
  const across = !down && dest.width > source.width;
  const seriesOf = new Map<number, ReturnType<typeof numberSeries>>();
  const series = (line: number) => {
    if (!seriesOf.has(line)) {
      const values: Array<number | null> = [];
      const length = down ? source.height : source.width;
      for (let i = 0; i < length; i++) {
        const text = down ? at(source.row + i, line) : at(line, source.column + i);
        values.push(NUMBER.test(text) ? Number(text) : null);
      }
      seriesOf.set(line, down || across ? numberSeries(values) : null);
    }
    return seriesOf.get(line)!;
  };
  const out: Array<{ row: number; column: number; text: string }> = [];
  for (let row = dest.row; row < dest.row + dest.height; row++) {
    for (let column = dest.column; column < dest.column + dest.width; column++) {
      const inside = row >= source.row && row < source.row + source.height && column >= source.column && column < source.column + source.width;
      if (inside || row < 0 || column < 0) continue;
      const srcRow = source.row + mod(row - source.row, source.height);
      const srcColumn = source.column + mod(column - source.column, source.width);
      const run = series(down ? column : row);
      let text: string;
      if (run) text = String(seriesValue(run, down ? row - source.row : column - source.column));
      else {
        const from = at(srcRow, srcColumn);
        text = isFormula(from) ? shiftFormula(from.trim(), row - srcRow, column - srcColumn) : from;
      }
      out.push({ row, column, text });
    }
  }
  return out;
}

/**
 * Where a fill-handle drag from `source` to the cell (`row`, `column`) fills: the source grown
 * down, up, right or left (whichever way the pointer went further), within the table's `rows`
 * and `columns`, never into the header from below it. Null while the pointer is still on the source.
 */
export function fillTarget(source: CellRect, row: number, column: number, rows: number, columns: number): CellRect | null {
  const top = source.row === 0 ? 0 : 1;
  const r = Math.max(top, Math.min(rows - 1, row));
  const c = Math.max(0, Math.min(columns - 1, column));
  const below = r - (source.row + source.height - 1);
  const above = source.row - r;
  const right = c - (source.column + source.width - 1);
  const left = source.column - c;
  const vertical = Math.max(below, above);
  const horizontal = Math.max(right, left);
  if (vertical <= 0 && horizontal <= 0) return null;
  if (vertical >= horizontal) {
    return below > 0 ? { ...source, height: source.height + below } : { ...source, row: r, height: source.height + above };
  }
  return right > 0 ? { ...source, width: source.width + right } : { ...source, column: c, width: source.width + left };
}
