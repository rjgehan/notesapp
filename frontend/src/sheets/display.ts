// How a cell's value reads (DESIGN §6.21.5, §6.21.8): in its number format (`fmt` of the cell, else
// of its row, else of its column), or the "Automatic" format of Google Sheets without one;
// TRUE/FALSE; errors as their code. Engine-free, for the grid, embeds, copies and exports.
import { toA1, columnLetters } from './a1';
import { cellValue, isCellError, type CachedValue, type Sheet } from './format';
import { formatGeneral, formatNumberWith, formatTextWith, type FormatColor } from './numfmt';

/** A number in the Automatic format. */
export const formatNumber = formatGeneral;

/** The text a value shows in the Automatic format. */
export function formatValue(value: CachedValue | undefined): string {
  return formatShown(value, undefined).text;
}

/** The text and colour a value shows in a number format (none: Automatic). */
export function formatShown(value: CachedValue | undefined, fmt: string | undefined): { text: string; color?: FormatColor } {
  if (value === null || value === undefined) return { text: '' };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
  if (typeof value === 'number') return formatNumberWith(value, fmt);
  if (isCellError(value)) return { text: value.e };
  return formatTextWith(value, fmt);
}

/** Numbers sit right, booleans and errors in the middle, text left, as in Google Sheets. */
export function valueAlign(value: CachedValue | undefined): 'left' | 'right' | 'center' {
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean' || isCellError(value ?? null)) return 'center';
  return 'left';
}

/** The number format that applies to a cell: its own, else its row's, else its column's. */
export function effectiveFormat(sheet: Sheet, col: number, row: number): string | undefined {
  return sheet.cells[toA1(col, row)]?.fmt ?? sheet.rows[String(row + 1)]?.fmt ?? sheet.cols[columnLetters(col)]?.fmt;
}

export interface ShownCell {
  value: CachedValue;
  text: string;
  align: 'left' | 'right' | 'center';
  /** A format's colour ([Red]), or the error colour's role for error results. */
  color?: FormatColor | 'error';
}

/** Everything the grid and embeds show for one cell. */
export function shownCell(sheet: Sheet, col: number, row: number): ShownCell {
  const value = cellValue(sheet.cells[toA1(col, row)]);
  const { text, color } = formatShown(value, effectiveFormat(sheet, col, row));
  const shown: ShownCell = { value, text, align: valueAlign(value) };
  if (isCellError(value)) shown.color = 'error';
  else if (color) shown.color = color;
  return shown;
}
