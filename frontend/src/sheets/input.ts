// Typed input (DESIGN §6.21.1, §6.21.8): what a cell holds after something was typed or pasted into
// it, as Google Sheets reads it. `=…` is a formula; numbers, TRUE and FALSE are values; percentages,
// amounts with a currency symbol, numbers with thousands separators, dates (2026-10-17, 10/17/2026)
// and times (14:30, 2:30 PM) are numbers that bring a number format along; a leading `'` forces
// text; anything else is text, kept exactly as typed. A cell formatted as plain text (`@`) takes
// everything as text. Engine-free.
import type { SheetCell } from './format';
import { dateSerial, formatKind, isDateKind, serialParts } from './numfmt';

export interface TypedInput {
  /** The new value or formula; null clears the cell. */
  content: Pick<SheetCell, 'v' | 'f'> | null;
  /** The number format the typing implies (`10%` → `0%`), applied when the cell has none. */
  fmt?: string;
}

// The patterns are unambiguous (one way to split the digits), so a long run of digits from a file
// or a CSV never backtracks quadratically.
const NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
/** Digits with optional thousands separators and decimals: `1,450.50`, `.5`. */
const AMOUNT = '((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]*)?|\\.[0-9]+)';
const PERCENT = new RegExp(`^([+-]?)${AMOUNT}\\s?%$`);
const CURRENCY = new RegExp(`^([+-]?)\\s?([$€£¥])\\s?([+-]?)${AMOUNT}$`);
const GROUPED = /^([+-]?)([0-9]{1,3}(?:,[0-9]{3})+)(\.[0-9]*)?$/;
const ISO_DATE = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$/;
const US_DATE = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4}|[0-9]{2})(?: ([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\s*([ap]m?)?)?$/i;
const TIME = /^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\s*([ap]m?)?$/i;

const decimalsOf = (digits: string) => digits.split('.')[1]?.length ?? 0;
const zeros = (n: number) => (n > 0 ? '.' + '0'.repeat(n) : '');
/** A quotient or product of a typed decimal, without binary noise (`10.1%` is 0.101, not 0.10099999999999999). */
const clean = (n: number) => Number(n.toPrecision(15));

function hours(h: number, ampm: string | undefined): number | null {
  if (!ampm) return h <= 23 ? h : null;
  if (h < 1 || h > 12) return null;
  const pm = ampm.toLowerCase().startsWith('p');
  return (h % 12) + (pm ? 12 : 0);
}

function timeFormat(seconds: boolean, ampm: boolean): string {
  return 'h:mm' + (seconds ? ':ss' : '') + (ampm ? ' AM/PM' : '');
}

/** A typed number, percentage, amount, date or time, with the format it implies; null for anything else. */
function typedNumber(t: string): { v: number; fmt?: string } | null {
  if (NUMBER.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? { v: n } : null;
  }
  let m = PERCENT.exec(t);
  if (m) {
    const n = Number(m[2].replace(/,/g, ''));
    return { v: clean((m[1] === '-' ? -n : n) / 100), fmt: '0' + zeros(decimalsOf(m[2])) + '%' };
  }
  m = CURRENCY.exec(t);
  if (m && !(m[1] && m[3])) {
    const n = Number(m[4].replace(/,/g, ''));
    const negative = m[1] === '-' || m[3] === '-';
    const symbol = m[2];
    return { v: negative ? -n : n, fmt: `${symbol}#,##0${symbol === '¥' ? '' : '.00'}` };
  }
  m = GROUPED.exec(t);
  if (m) {
    const n = Number(m[2].replace(/,/g, '') + (m[3] ?? ''));
    return { v: m[1] === '-' ? -n : n, fmt: '#,##0' + zeros(decimalsOf(m[3] ?? '')) };
  }
  m = ISO_DATE.exec(t);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const serial = dateSerial(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
    if (serial === null || Number(y) < 1900) return null;
    return { v: serial, fmt: h === undefined ? 'yyyy-mm-dd' : 'yyyy-mm-dd ' + timeFormat(s !== undefined, false) };
  }
  m = US_DATE.exec(t);
  if (m) {
    const [, mo, d, y, h, mi, s, ampm] = m;
    // Two-digit years: 00–29 are 2000–2029, 30–99 are 1930–1999 (Excel's and Google Sheets' rule).
    const year = y.length === 2 ? (Number(y) < 30 ? 2000 : 1900) + Number(y) : Number(y);
    const hour = h === undefined ? 0 : hours(Number(h), ampm);
    if (hour === null) return null;
    const serial = dateSerial(year, Number(mo), Number(d), hour, Number(mi ?? 0), Number(s ?? 0));
    if (serial === null || year < 1900) return null;
    return { v: serial, fmt: h === undefined ? 'm/d/yyyy' : 'm/d/yyyy ' + timeFormat(s !== undefined, ampm !== undefined) };
  }
  m = TIME.exec(t);
  if (m) {
    const [, h, mi, s, ampm] = m;
    const hour = hours(Number(h), ampm);
    if (hour === null || Number(mi) > 59 || Number(s ?? 0) > 59) return null;
    return { v: (hour * 3600 + Number(mi) * 60 + Number(s ?? 0)) / 86400, fmt: timeFormat(s !== undefined, ampm !== undefined) };
  }
  return null;
}

/** What typing `text` into a cell makes of it; `plainText` when the cell is formatted as plain text (`@`). */
export function typedInput(text: string, opts: { plainText?: boolean } = {}): TypedInput {
  if (text === '') return { content: null };
  if (opts.plainText) return { content: { v: text } };
  if (text.startsWith('=') && text.length > 1) return { content: { f: text } };
  if (text.startsWith("'")) return { content: { v: text.slice(1) } };
  const trimmed = text.trim();
  if (/^(true|false)$/i.test(trimmed)) return { content: { v: trimmed.toLowerCase() === 'true' } };
  const number = typedNumber(trimmed);
  if (number) return number.fmt ? { content: { v: number.v }, fmt: number.fmt } : { content: { v: number.v } };
  return { content: { v: text } };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A number as the formula bar shows it for editing, in a form typedInput() reads back: dates and
 * times as ISO text (`2026-10-17`, `2026-10-17 14:30`, `14:30:15`), percentages as `12.5%`, other
 * numbers as plain digits whatever their format.
 */
export function numberText(v: number, fmt: string | undefined): string {
  const kind = formatKind(fmt);
  if (isDateKind(kind) && v >= 0) {
    const p = serialParts(v);
    const time = p ? `${p.hour}:${pad2(p.minute)}${p.second ? ':' + pad2(p.second) : ''}` : '';
    if (p && kind === 'time' && v < 1) return time;
    if (p && p.year >= 1900) {
      const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
      const whole = Math.abs(v - Math.round(v)) < 1 / 86400 / 2;
      return whole && kind !== 'time' ? date : `${date} ${time}`;
    }
  }
  if (kind === 'percent') {
    const percent = String(clean(v * 100));
    if (!percent.includes('e')) return percent + '%';
  }
  return String(v);
}
