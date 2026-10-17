// How a cell's value reads in the grid (DESIGN §6.21.5), the "Automatic" format of Google Sheets:
// up to 15 significant digits for whole numbers, 10 for fractions (so 0.1 + 0.2 shows 0.3),
// scientific notation for very large and very small numbers, TRUE/FALSE, and errors as their code.
// Number formats (`fmt`) arrive with 6c. Engine-free, for the grid now and embeds later.
import { isCellError, type CachedValue } from './format';

function trimMantissa(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const rounded = Number(n.toPrecision(15));
  const abs = Math.abs(rounded);
  if (abs >= 1e15 || abs < 1e-6) {
    const [mantissa, exponent] = rounded.toExponential(9).split('e');
    const e = Number(exponent);
    return `${trimMantissa(mantissa)}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (Number.isInteger(rounded)) return String(rounded);
  // Ten significant digits, or as many as the whole part has, so toPrecision never switches to
  // an exponent between 1e-6 and 1e15.
  const precision = Math.min(15, Math.max(10, Math.floor(Math.log10(abs)) + 1));
  return trimMantissa(rounded.toPrecision(precision));
}

/** The text a cell shows for its value or cached result. */
export function formatValue(value: CachedValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return formatNumber(value);
  if (isCellError(value)) return value.e;
  return value;
}

/** Numbers sit right, booleans and errors in the middle, text left, as in Google Sheets. */
export function valueAlign(value: CachedValue | undefined): 'left' | 'right' | 'center' {
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean' || isCellError(value ?? null)) return 'center';
  return 'left';
}
