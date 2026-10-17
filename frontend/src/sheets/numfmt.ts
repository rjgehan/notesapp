// Number formats (ROADMAP item 6c, DESIGN §6.21.8): the format codes of Excel and Google Sheets,
// stored in a cell's, row's or column's `fmt` (`$#,##0.00`, `0.0%`, `yyyy-mm-dd`). Up to four
// sections (positive;negative;zero;text), digit placeholders 0 # ?, thousands separators and
// scaling commas, percent, scientific notation, quoted and escaped literals, `@` for text, dates
// and times (y m d h s, AM/PM, elapsed [h]), `General`, `[$€-407]` currency tags and the colours
// [Red] [Green] [Blue]. Conditions (`[>100]`), fractions and fill characters are not supported:
// conditions are ignored, fractions read as literals, and `*x` and `_x` give one space.
// Engine-free and dependency-free: the grid, embeds, CSV export and xlsx all format through it.

// ---------- the Automatic format ----------

function trimMantissa(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * A number in the "Automatic" format of Google Sheets: up to 15 significant digits for whole
 * numbers, 10 for fractions (so 0.1 + 0.2 shows 0.3), scientific notation from 1E+15 and below 1E-06.
 */
export function formatGeneral(n: number): string {
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

// ---------- dates as serial numbers ----------

/** Serial day 0 is 1899-12-30, as in Google Sheets, HyperFormula and Excel after February 1900. */
const EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export interface DateParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** The serial number of a date and time, or null when the date does not exist. */
export function dateSerial(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | null {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return (ms - EPOCH) / DAY_MS + (hour * 3600 + minute * 60 + second) / 86400;
}

/** The date and time a serial number stands for, rounded to `precision` ms; null outside years 0–9999. */
export function serialParts(serial: number, precision = 1000): DateParts | null {
  if (!Number.isFinite(serial)) return null;
  const ms = Math.round((serial * DAY_MS) / precision) * precision + EPOCH;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || year < 0 || year > 9999) return null;
  return {
    year,
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
    weekday: d.getUTCDay(),
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- compiling a format ----------

export type FormatColor = 'red' | 'green' | 'blue';

type Token =
  | { t: 'lit'; s: string }
  | { t: 'digit'; c: '0' | '#' | '?' }
  | { t: 'point' }
  | { t: 'comma' }
  | { t: 'percent' }
  | { t: 'exp'; plus: boolean }
  | { t: 'text' }
  | { t: 'general' }
  | { t: 'date'; code: string }
  | { t: 'elapsed'; unit: 'h' | 'm' | 's'; width: number }
  | { t: 'subsec'; digits: number }
  | { t: 'ampm'; short: boolean; lower: boolean };

interface Section {
  tokens: Token[];
  color?: FormatColor;
  kind: 'number' | 'date' | 'text' | 'general' | 'literal';
  /** Number sections: placeholders of the whole part, the fraction and the exponent. */
  int: Array<'0' | '#' | '?'>;
  frac: Array<'0' | '#' | '?'>;
  exp: Array<'0' | '#' | '?'>;
  grouping: boolean;
  /** Trailing commas: each divides by 1000. */
  scale: number;
  percent: number;
  /** Date sections: hours on a 12-hour clock. */
  twelve: boolean;
}

interface Compiled {
  sections: Section[];
}

const COLORS: Record<string, FormatColor> = { red: 'red', green: 'green', blue: 'blue' };
const compiled = new Map<string, Compiled>();

/** Splits at `;` outside quotes, escapes and brackets. */
function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') {
      const end = fmt.indexOf('"', i + 1);
      const stop = end < 0 ? fmt.length : end + 1;
      cur += fmt.slice(i, stop);
      i = stop - 1;
    } else if (ch === '\\' && i + 1 < fmt.length) {
      cur += fmt.slice(i, i + 2);
      i++;
    } else if (ch === '[') {
      const end = fmt.indexOf(']', i + 1);
      const stop = end < 0 ? fmt.length : end + 1;
      cur += fmt.slice(i, stop);
      i = stop - 1;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function lit(tokens: Token[], s: string): void {
  const last = tokens[tokens.length - 1];
  if (last?.t === 'lit') last.s += s;
  else tokens.push({ t: 'lit', s });
}

function tokenize(src: string): { tokens: Token[]; color?: FormatColor } {
  const tokens: Token[] = [];
  let color: FormatColor | undefined;
  let i = 0;
  const lower = src.toLowerCase();
  while (i < src.length) {
    const ch = src[i];
    const lc = lower[i];
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      lit(tokens, src.slice(i + 1, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 1;
    } else if (ch === '\\') {
      if (i + 1 < src.length) lit(tokens, src[i + 1]);
      i += 2;
    } else if (ch === '_' || ch === '*') {
      // Padding to the width of a character, or a fill: one space.
      if (ch === '_') lit(tokens, ' ');
      i += 2;
    } else if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
      const b = body.toLowerCase();
      if (COLORS[b]) color = COLORS[b];
      else if (/^h+$/.test(b) || /^m+$/.test(b) || /^s+$/.test(b)) tokens.push({ t: 'elapsed', unit: b[0] as 'h' | 'm' | 's', width: b.length });
      else if (body.startsWith('$')) {
        // [$€-407]: a currency symbol with a locale; [$-409]: only a locale.
        const symbol = body.slice(1).split('-')[0];
        if (symbol) lit(tokens, symbol);
      }
      // Other colours, conditions: ignored.
    } else if (lower.startsWith('general', i)) {
      tokens.push({ t: 'general' });
      i += 7;
    } else if (lower.startsWith('am/pm', i)) {
      tokens.push({ t: 'ampm', short: false, lower: src[i] === 'a' });
      i += 5;
    } else if (lower.startsWith('a/p', i)) {
      tokens.push({ t: 'ampm', short: true, lower: src[i] === 'a' });
      i += 3;
    } else if (lc === 'y' || lc === 'm' || lc === 'd' || lc === 'h' || lc === 's' || (lc === 'e' && !/[+-]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && lower[j] === lc) j++;
      tokens.push({ t: 'date', code: lc.repeat(j - i) });
      i = j;
    } else if (ch === '0' || ch === '#' || ch === '?') {
      tokens.push({ t: 'digit', c: ch });
      i++;
    } else if (ch === '.') {
      // `.0` after seconds is a fraction of a second.
      const prev = [...tokens].reverse().find((t) => t.t !== 'lit');
      if (prev?.t === 'date' && prev.code.startsWith('s') && src[i + 1] === '0') {
        let j = i + 1;
        while (src[j] === '0') j++;
        tokens.push({ t: 'subsec', digits: j - i - 1 });
        i = j;
      } else {
        tokens.push({ t: 'point' });
        i++;
      }
    } else if (ch === ',') {
      tokens.push({ t: 'comma' });
      i++;
    } else if (ch === '%') {
      tokens.push({ t: 'percent' });
      i++;
    } else if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      tokens.push({ t: 'exp', plus: src[i + 1] === '+' });
      i += 2;
    } else if (ch === '@') {
      tokens.push({ t: 'text' });
      i++;
    } else {
      lit(tokens, ch);
      i++;
    }
  }
  return { tokens, color };
}

function compileSection(src: string): Section {
  const { tokens, color } = tokenize(src);
  const section: Section = { tokens, color, kind: 'literal', int: [], frac: [], exp: [], grouping: false, scale: 0, percent: 0, twelve: false };
  const has = (t: Token['t']) => tokens.some((x) => x.t === t);
  if (has('date') || has('elapsed')) {
    section.kind = 'date';
    section.twelve = has('ampm');
    // `m` and `mm` are minutes after an hour or before a second, months otherwise.
    const timeParts = tokens.filter((t): t is Extract<Token, { t: 'date' | 'elapsed' }> => t.t === 'date' || t.t === 'elapsed');
    timeParts.forEach((t, k) => {
      if (t.t !== 'date' || (t.code !== 'm' && t.code !== 'mm')) return;
      const prev = timeParts[k - 1];
      const next = timeParts[k + 1];
      const afterHour = prev && ((prev.t === 'date' && prev.code.startsWith('h')) || (prev.t === 'elapsed' && prev.unit === 'h'));
      const beforeSecond = next && ((next.t === 'date' && next.code.startsWith('s')) || (next.t === 'elapsed' && next.unit === 's'));
      if (afterHour || beforeSecond) t.code = t.code === 'm' ? 'M' : 'MM';
    });
    return section;
  }
  if (has('general')) {
    section.kind = 'general';
    return section;
  }
  if (has('digit') || has('point') || has('percent') || has('exp')) {
    section.kind = 'number';
    let part: 'int' | 'frac' | 'exp' = 'int';
    let seenDigit = false;
    tokens.forEach((t, k) => {
      if (t.t === 'digit') {
        section[part].push(t.c);
        seenDigit = true;
      } else if (t.t === 'point' && part === 'int') part = 'frac';
      else if (t.t === 'exp') part = 'exp';
      else if (t.t === 'percent') section.percent++;
      else if (t.t === 'comma' && part !== 'exp' && seenDigit) {
        // Between digit placeholders of the whole part: thousands; after the last placeholder of
        // the number (before or after its decimals): scaling by 1000.
        const rest = tokens.slice(k + 1);
        const nextDigit = rest.findIndex((x) => x.t === 'digit' || x.t === 'point' || x.t === 'exp');
        if (part === 'int' && nextDigit >= 0 && rest[nextDigit].t === 'digit' && rest.slice(0, nextDigit).every((x) => x.t === 'comma')) section.grouping = true;
        else if (nextDigit < 0 || rest[nextDigit].t !== 'digit') section.scale++;
      }
    });
    return section;
  }
  if (has('text')) section.kind = 'text';
  return section;
}

function compile(fmt: string): Compiled {
  let c = compiled.get(fmt);
  if (!c) {
    c = { sections: splitSections(fmt).slice(0, 4).map(compileSection) };
    if (compiled.size > 500) compiled.clear();
    compiled.set(fmt, c);
  }
  return c;
}

// ---------- numbers ----------

/**
 * `x` (not negative) rounded half up to `d` decimals on its 15 significant digits, as Excel and
 * Google Sheets show it: 1.005 to two decimals is 1.01 although the double is just below.
 */
export function fixedDigits(x: number, d: number): { int: string; frac: string } {
  if (x === 0) return { int: '0', frac: '0'.repeat(d) };
  const [m, e] = x.toExponential(14).split('e');
  const digits = m.replace('.', '');
  const exp = Number(e);
  let int: string;
  let frac: string;
  if (exp >= 0) {
    int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    frac = digits.slice(exp + 1);
  } else {
    int = '0';
    frac = '0'.repeat(-exp - 1) + digits;
  }
  if (frac.length > d) {
    const up = frac[d] >= '5';
    frac = frac.slice(0, d);
    if (up) {
      // Add one in the last kept place, carrying through the whole part.
      const all = (int + frac).split('');
      let k = all.length - 1;
      while (k >= 0 && all[k] === '9') all[k--] = '0';
      if (k >= 0) all[k] = String(Number(all[k]) + 1);
      else all.unshift('1');
      int = all.slice(0, all.length - d).join('');
      frac = all.slice(all.length - d).join('');
    }
  } else frac = frac.padEnd(d, '0');
  return { int: int.replace(/^0+(?=\d)/, ''), frac };
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Digits for the placeholders of the whole part, filled from the right; the first takes the rest. */
function fillInteger(digits: string, placeholders: Array<'0' | '#' | '?'>): string[] {
  const out: string[] = [];
  let rest = digits === '0' ? '' : digits;
  for (let k = placeholders.length - 1; k >= 0; k--) {
    const p = placeholders[k];
    if (k === 0) {
      out.unshift(rest !== '' ? rest : p === '0' ? '0' : p === '?' ? ' ' : '');
    } else if (rest !== '') {
      out.unshift(rest[rest.length - 1]);
      rest = rest.slice(0, -1);
    } else out.unshift(p === '0' ? '0' : p === '?' ? ' ' : '');
  }
  return out;
}

/** Fraction digits for the placeholders, trailing zeros dropped where the placeholder is `#` (or `?`, as a space). */
function fillFraction(digits: string, placeholders: Array<'0' | '#' | '?'>): string[] {
  const out = placeholders.map((_, k) => digits[k] ?? '0');
  for (let k = placeholders.length - 1; k >= 0; k--) {
    if (out[k] !== '0' || placeholders[k] === '0') break;
    out[k] = placeholders[k] === '?' ? ' ' : '';
  }
  return out;
}

function formatNumberSection(s: Section, value: number, sign: string): string {
  let x = value * 100 ** s.percent / 1000 ** s.scale;
  let exponent = 0;
  const scientific = s.exp.length > 0;
  if (scientific && x !== 0) {
    exponent = Math.floor(Math.log10(x)) - Math.max(0, s.int.length - 1);
    x = x / 10 ** exponent;
    if (fixedDigits(x, s.frac.length).int.length > Math.max(1, s.int.length)) {
      exponent++;
      x /= 10;
    }
  }
  const { int, frac } = fixedDigits(x, s.frac.length);
  const zero = /^0*$/.test(int) && /^0*$/.test(frac);
  const ints = fillInteger(int, s.int.length > 0 ? s.int : ['#']);
  const fracs = fillFraction(frac, s.frac);
  const expText = String(Math.abs(exponent)).padStart(s.exp.filter((p) => p === '0').length, '0');
  let out = zero ? '' : sign;
  let ii = 0;
  let fi = 0;
  let expWritten = false;
  let part: 'int' | 'frac' | 'exp' = 'int';
  for (const t of s.tokens) {
    switch (t.t) {
      case 'digit':
        if (part === 'int') {
          if (s.grouping) {
            if (ii === 0) out += group(ints.join(''));
          } else out += ints[ii] ?? '';
          ii++;
        } else if (part === 'frac') out += fracs[fi++] ?? '';
        else if (!expWritten) {
          // The exponent is written once, at its first placeholder.
          out += expText;
          expWritten = true;
        }
        break;
      case 'point':
        if (part === 'int') {
          if (s.int.length === 0 && ii === 0) out += ints.join('');
          out += '.';
          part = 'frac';
        } else out += '.';
        break;
      case 'exp':
        out += 'E' + (exponent < 0 ? '-' : t.plus ? '+' : '');
        part = 'exp';
        break;
      case 'percent':
        out += '%';
        break;
      case 'comma':
        break;
      case 'lit':
        out += t.s;
        break;
      case 'text':
      case 'general':
      case 'date':
      case 'elapsed':
      case 'subsec':
      case 'ampm':
        break;
    }
  }
  return out;
}

// ---------- dates ----------

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function formatDateSection(s: Section, serial: number): string | null {
  const subsec = s.tokens.find((t): t is Extract<Token, { t: 'subsec' }> => t.t === 'subsec');
  const precision = subsec ? 10 ** (3 - Math.min(3, subsec.digits)) : 1000;
  const p = serialParts(serial, precision);
  if (!p || serial < 0) return null;
  const totalSeconds = Math.round((serial * 86400 * 1000) / precision) * precision / 1000;
  let out = '';
  for (const t of s.tokens) {
    switch (t.t) {
      case 'lit':
        out += t.s;
        break;
      case 'date': {
        const c = t.code;
        if (c.startsWith('y')) out += c.length <= 2 ? pad(p.year % 100, 2) : pad(p.year, 4);
        else if (c === 'm') out += p.month;
        else if (c === 'mm') out += pad(p.month, 2);
        else if (c === 'mmm') out += MONTHS[p.month - 1].slice(0, 3);
        else if (c === 'mmmmm') out += MONTHS[p.month - 1][0];
        else if (c.startsWith('mmmm')) out += MONTHS[p.month - 1];
        else if (c === 'M') out += p.minute;
        else if (c === 'MM') out += pad(p.minute, 2);
        else if (c === 'd') out += p.day;
        else if (c === 'dd') out += pad(p.day, 2);
        else if (c === 'ddd') out += WEEKDAYS[p.weekday].slice(0, 3);
        else if (c.startsWith('dddd')) out += WEEKDAYS[p.weekday];
        else if (c.startsWith('h')) {
          const h = s.twelve ? p.hour % 12 || 12 : p.hour;
          out += c.length >= 2 ? pad(h, 2) : String(h);
        } else if (c.startsWith('s')) out += c.length >= 2 ? pad(p.second, 2) : String(p.second);
        else if (c.startsWith('e')) out += p.year;
        else out += c;
        break;
      }
      case 'elapsed': {
        const n = Math.floor(totalSeconds / (t.unit === 'h' ? 3600 : t.unit === 'm' ? 60 : 1));
        out += pad(n, t.width);
        break;
      }
      case 'subsec':
        out += '.' + pad(p.millisecond, 3).slice(0, t.digits);
        break;
      case 'ampm': {
        const pm = p.hour >= 12;
        const text = t.short ? (pm ? 'P' : 'A') : pm ? 'PM' : 'AM';
        out += t.lower ? text.toLowerCase() : text;
        break;
      }
      default:
        if (t.t === 'point') out += '.';
        else if (t.t === 'comma') out += ',';
        else if (t.t === 'percent') out += '%';
        else if (t.t === 'digit') out += t.c;
        break;
    }
  }
  return out;
}

function literalSection(s: Section, text?: string): string {
  let out = '';
  for (const t of s.tokens) {
    if (t.t === 'lit') out += t.s;
    else if (t.t === 'text') out += text ?? '';
  }
  return out;
}

// ---------- formatting ----------

export interface Formatted {
  text: string;
  color?: FormatColor;
}

/** Whether a format is the Automatic one (no format at all, or `General`). */
export function isGeneral(fmt: string | undefined): boolean {
  return fmt === undefined || fmt.trim() === '' || fmt.trim().toLowerCase() === 'general';
}

/** A number in a format. Without one (or with `General`), the Automatic format. */
export function formatNumberWith(value: number, fmt: string | undefined): Formatted {
  if (!Number.isFinite(value)) return { text: '#NUM!' };
  if (isGeneral(fmt)) return { text: formatGeneral(value) };
  const { sections } = compile(fmt as string);
  const numeric = sections.filter((s) => s.kind !== 'text');
  let s: Section;
  let x = value;
  let sign = '';
  if (numeric.length >= 3 && value === 0) s = numeric[2];
  else if (numeric.length >= 2 && value < 0) {
    s = numeric[1];
    x = -value;
  } else {
    s = numeric[0] ?? sections[0];
    if (value < 0) {
      x = -value;
      sign = '-';
    }
  }
  if (!s) return { text: formatGeneral(value) };
  const color = s.color ? { color: s.color } : {};
  switch (s.kind) {
    case 'number':
      return { text: formatNumberSection(s, x, sign), ...color };
    case 'date': {
      const text = formatDateSection(s, value);
      // A date before day 0 or after 9999 cannot be shown as one.
      return text === null ? { text: formatGeneral(value), ...color } : { text, ...color };
    }
    case 'general': {
      const general = formatGeneral(x);
      let out = sign;
      for (const t of s.tokens) out += t.t === 'general' ? general : t.t === 'lit' ? t.s : '';
      return { text: out, ...color };
    }
    case 'text':
      return { text: formatGeneral(value) };
    case 'literal':
      return { text: literalSection(s), ...color };
  }
}

/** Text in a format: the text section (the fourth, or a lone `@` section) wraps it; otherwise it shows as it is. */
export function formatTextWith(text: string, fmt: string | undefined): Formatted {
  if (isGeneral(fmt)) return { text };
  const { sections } = compile(fmt as string);
  const s = sections.length >= 4 ? sections[3] : sections.find((x) => x.kind === 'text');
  if (!s) return { text };
  return { text: literalSection(s, text), ...(s.color ? { color: s.color } : {}) };
}

// ---------- kinds, presets, decimals ----------

export type FormatKind = 'general' | 'number' | 'percent' | 'currency' | 'scientific' | 'date' | 'time' | 'datetime' | 'duration' | 'text';

const CURRENCY = /[$€£¥₹₩₽¢]/;

/** What kind of values a format shows, judged by its first section. */
export function formatKind(fmt: string | undefined): FormatKind {
  if (isGeneral(fmt)) return 'general';
  const s = compile(fmt as string).sections[0];
  if (!s) return 'general';
  if (s.kind === 'text') return 'text';
  if (s.kind === 'date') {
    if (s.tokens.some((t) => t.t === 'elapsed')) return 'duration';
    const codes = s.tokens.flatMap((t) => (t.t === 'date' ? [t.code] : []));
    const date = codes.some((c) => /^[ymde]/.test(c) || c === 'm' || c === 'mm' || c.startsWith('mmm') || c.startsWith('d'));
    const time = codes.some((c) => c.startsWith('h') || c.startsWith('s') || c === 'M' || c === 'MM') || s.tokens.some((t) => t.t === 'ampm');
    return date && time ? 'datetime' : time ? 'time' : 'date';
  }
  if (s.kind !== 'number') return 'general';
  if (s.percent > 0) return 'percent';
  if (s.exp.length > 0) return 'scientific';
  if (s.tokens.some((t) => t.t === 'lit' && CURRENCY.test(t.s))) return 'currency';
  return 'number';
}

/** Whether a format shows dates or times, so typed and edited values read as dates. */
export const isDateKind = (k: FormatKind) => k === 'date' || k === 'time' || k === 'datetime';

export interface FormatPreset {
  id: string;
  label: string;
  /** undefined: Automatic. */
  fmt: string | undefined;
  /** What 1234.5678 (or a date) looks like in it, for the menu. */
  sample: string;
}

const SAMPLE_DATE = 46312.5625; // 2026-10-17 13:30

/** The formats offered in the Number format menu, as in Google Sheets (US English). */
export const FORMAT_PRESETS: FormatPreset[] = [
  { id: 'auto', label: 'Automatic', fmt: undefined, sample: '' },
  { id: 'text', label: 'Plain text', fmt: '@', sample: '' },
  { id: 'number', label: 'Number', fmt: '#,##0.00', sample: '' },
  { id: 'percent', label: 'Percent', fmt: '0.00%', sample: '' },
  { id: 'scientific', label: 'Scientific', fmt: '0.00E+00', sample: '' },
  { id: 'financial', label: 'Financial', fmt: '#,##0.00;(#,##0.00)', sample: '' },
  { id: 'currency', label: 'Currency', fmt: '$#,##0.00', sample: '' },
  { id: 'currencyRounded', label: 'Currency rounded', fmt: '$#,##0', sample: '' },
  { id: 'date', label: 'Date', fmt: 'yyyy-mm-dd', sample: '' },
  { id: 'dateUs', label: 'Date (US)', fmt: 'm/d/yyyy', sample: '' },
  { id: 'dateLong', label: 'Date (long)', fmt: 'mmmm d, yyyy', sample: '' },
  { id: 'time', label: 'Time', fmt: 'h:mm:ss AM/PM', sample: '' },
  { id: 'datetime', label: 'Date time', fmt: 'yyyy-mm-dd h:mm', sample: '' },
  { id: 'duration', label: 'Duration', fmt: '[h]:mm:ss', sample: '' },
].map((p) => {
  if (p.fmt === undefined || p.fmt === '@') return p;
  const kind = formatKind(p.fmt);
  const value = isDateKind(kind) ? SAMPLE_DATE : kind === 'duration' ? 1.5 : p.id === 'financial' ? -1234.5678 : kind === 'percent' ? 0.1234 : 1234.5678;
  return { ...p, sample: formatNumberWith(value, p.fmt).text };
});

/** Index of the first digit placeholder outside quotes, escapes and brackets, or -1. */
function firstPlaceholder(section: string): number {
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      i = end < 0 ? section.length : end;
    } else if (ch === '\\' || ch === '_' || ch === '*') i++;
    else if (ch === '[') {
      const end = section.indexOf(']', i + 1);
      i = end < 0 ? section.length : end;
    } else if (ch === '0' || ch === '#' || ch === '?') return i;
  }
  return -1;
}

/** One section with one decimal place more (`delta` 1) or less (-1). */
function sectionDecimals(section: string, delta: 1 | -1): string {
  const start = firstPlaceholder(section);
  if (start < 0) return section;
  let i = start;
  while (i < section.length && /[0#?,]/.test(section[i])) i++;
  let fracStart = -1;
  let end = i;
  if (section[i] === '.') {
    fracStart = i + 1;
    end = fracStart;
    while (end < section.length && /[0#?]/.test(section[end])) end++;
  }
  const head = section.slice(0, i);
  const tail = section.slice(end);
  const decimals = fracStart < 0 ? 0 : end - fracStart;
  const next = Math.max(0, decimals + delta);
  return head + (next > 0 ? '.' + '0'.repeat(next) : '') + tail;
}

/**
 * A number format with one decimal place more or less: the Increase and Decrease decimal places
 * buttons. Automatic becomes a fixed format with as many decimals as `value` shows, plus or minus
 * one. Dates, times and text stay as they are (null).
 */
export function changeDecimals(fmt: string | undefined, delta: 1 | -1, value: number | null): string | null {
  const kind = formatKind(fmt);
  if (kind === 'general') {
    const shown = value === null ? '0' : formatGeneral(Math.abs(value));
    const decimals = /E/.test(shown) ? 2 : (shown.split('.')[1]?.length ?? 0);
    const next = Math.max(0, decimals + delta);
    return next > 0 ? '0.' + '0'.repeat(next) : '0';
  }
  if (isDateKind(kind) || kind === 'duration' || kind === 'text') return null;
  return splitSections(fmt as string)
    .map((s) => sectionDecimals(s, delta))
    .join(';');
}
