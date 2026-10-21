import { describe, expect, it } from 'vitest';
import {
  changeDecimals,
  dateSerial,
  fixedDigits,
  formatGeneral,
  formatKind,
  formatNumberWith,
  formatTextWith,
  FORMAT_PRESETS,
  serialParts,
} from './numfmt';

const fmt = (value: number, format: string | undefined) => formatNumberWith(value, format).text;

describe('formatGeneral (Automatic)', () => {
  it('shows up to 15 significant digits for whole numbers and 10 for fractions', () => {
    expect(formatGeneral(1450)).toBe('1450');
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(1 / 3)).toBe('0.3333333333');
    expect(formatGeneral(-2.5)).toBe('-2.5');
    expect(formatGeneral(123456789012345)).toBe('123456789012345');
  });

  it('switches to scientific notation for very large and very small numbers', () => {
    expect(formatGeneral(1e15)).toBe('1E+15');
    expect(formatGeneral(1.5e-7)).toBe('1.5E-07');
    expect(formatGeneral(0)).toBe('0');
    expect(formatGeneral(Infinity)).toBe('#NUM!');
  });
});

describe('dates as serial numbers', () => {
  it('counts days from 1899-12-30 as Google Sheets and HyperFormula do', () => {
    expect(dateSerial(1899, 12, 30)).toBe(0);
    expect(dateSerial(1900, 1, 1)).toBe(2);
    expect(dateSerial(2026, 10, 17)).toBe(46312);
    expect(dateSerial(2026, 10, 17, 13, 30)).toBe(46312.5625);
  });

  it('refuses dates that do not exist', () => {
    expect(dateSerial(2026, 2, 29)).toBeNull();
    expect(dateSerial(2024, 2, 29)).toBe(45351);
    expect(dateSerial(2026, 13, 1)).toBeNull();
    expect(dateSerial(2026, 1, 1, 24)).toBeNull();
  });

  it('reads a serial number back, rounded to the second', () => {
    expect(serialParts(46312.5625)).toMatchObject({ year: 2026, month: 10, day: 17, hour: 13, minute: 30, second: 0, weekday: 6 });
    expect(serialParts(46312 + 59.9996 / 86400)).toMatchObject({ hour: 0, minute: 1, second: 0 });
    expect(serialParts(Number.NaN)).toBeNull();
    expect(serialParts(1e9)).toBeNull();
  });
});

describe('fixedDigits', () => {
  it('rounds half up on 15 significant digits, as spreadsheets show numbers', () => {
    expect(fixedDigits(1.005, 2)).toEqual({ int: '1', frac: '01' });
    expect(fixedDigits(2.675, 2)).toEqual({ int: '2', frac: '68' });
    expect(fixedDigits(9.995, 2)).toEqual({ int: '10', frac: '00' });
    expect(fixedDigits(0.0004, 3)).toEqual({ int: '0', frac: '000' });
    expect(fixedDigits(0.0005, 3)).toEqual({ int: '0', frac: '001' });
    expect(fixedDigits(1234.5, 0)).toEqual({ int: '1235', frac: '' });
    expect(fixedDigits(1e21, 0)).toEqual({ int: '1000000000000000000000', frac: '' });
  });
});

describe('formatNumberWith', () => {
  it('uses the Automatic format without a format or with General', () => {
    expect(fmt(1234.5, undefined)).toBe('1234.5');
    expect(fmt(1234.5, 'General')).toBe('1234.5');
    expect(fmt(1234.5, '')).toBe('1234.5');
  });

  it('fills digit placeholders, decimals and thousands separators', () => {
    expect(fmt(1234.5678, '0.00')).toBe('1234.57');
    expect(fmt(1234.5678, '#,##0.00')).toBe('1,234.57');
    expect(fmt(1234567.891, '#,##0')).toBe('1,234,568');
    expect(fmt(0, '#,##0.00')).toBe('0.00');
    expect(fmt(0.5, '#.##')).toBe('.5');
    expect(fmt(5, '#.##')).toBe('5.');
    expect(fmt(5, '000')).toBe('005');
    expect(fmt(5.1, '0.0#')).toBe('5.1');
    expect(fmt(5.125, '0.0#')).toBe('5.13');
    expect(fmt(5551234, '000-0000')).toBe('555-1234');
    expect(fmt(3.5, '?.??')).toBe('3.5 ');
  });

  it('writes negative numbers with a sign, or with the negative section', () => {
    expect(fmt(-1234.5, '#,##0.00')).toBe('-1,234.50');
    expect(fmt(-1234.5, '#,##0.00;(#,##0.00)')).toBe('(1,234.50)');
    expect(fmt(0, '#,##0.00;(#,##0.00);"-"')).toBe('-');
    expect(fmt(-0.001, '0.00')).toBe('0.00');
  });

  it('shows currencies, percentages, scaling and scientific notation', () => {
    expect(fmt(1450, '$#,##0.00')).toBe('$1,450.00');
    expect(fmt(-1450, '$#,##0.00')).toBe('-$1,450.00');
    expect(fmt(1450, '[$€-407]#,##0.00')).toBe('€1,450.00');
    expect(fmt(1450, '#,##0.00 "€"')).toBe('1,450.00 €');
    expect(fmt(0.1234, '0.00%')).toBe('12.34%');
    expect(fmt(0.5, '0%')).toBe('50%');
    expect(fmt(1234567, '#,##0,"K"')).toBe('1,235K');
    expect(fmt(1234567, '0.0,,"M"')).toBe('1.2M');
    expect(fmt(1234.5678, '0.00E+00')).toBe('1.23E+03');
    expect(fmt(0.000123, '0.00E+00')).toBe('1.23E-04');
    expect(fmt(9.999, '0.00E+00')).toBe('1.00E+01');
    expect(fmt(0, '0.00E+00')).toBe('0.00E+00');
  });

  it('keeps literals, escapes and padding', () => {
    expect(fmt(12, '0 "items"')).toBe('12 items');
    expect(fmt(12, '\\#0')).toBe('#12');
    expect(fmt(12, '0_)')).toBe('12 ');
    expect(fmt(1, 'General" kg"')).toBe('1 kg');
  });

  it('returns the colour of a section', () => {
    expect(formatNumberWith(-5, '0;[Red]-0')).toEqual({ text: '-5', color: 'red' });
    expect(formatNumberWith(5, '[Green]0;[Red]-0')).toEqual({ text: '5', color: 'green' });
    expect(formatNumberWith(5, '[Magenta]0')).toEqual({ text: '5' });
  });

  it('ignores conditions rather than failing', () => {
    expect(fmt(150, '[>100]0.0;0')).toBe('150.0');
  });

  it('shows dates and times', () => {
    const at = dateSerial(2026, 10, 17, 13, 5, 9) as number;
    expect(fmt(at, 'yyyy-mm-dd')).toBe('2026-10-17');
    expect(fmt(at, 'm/d/yyyy')).toBe('10/17/2026');
    expect(fmt(at, 'mmmm d, yyyy')).toBe('October 17, 2026');
    expect(fmt(at, 'ddd, mmm d yy')).toBe('Sat, Oct 17 26');
    expect(fmt(at, 'dddd')).toBe('Saturday');
    expect(fmt(at, 'h:mm:ss AM/PM')).toBe('1:05:09 PM');
    expect(fmt(at, 'hh:mm')).toBe('13:05');
    expect(fmt(at, 'h:mm a/p')).toBe('1:05 p');
    expect(fmt(at, 'yyyy-mm-dd h:mm')).toBe('2026-10-17 13:05');
    expect(fmt(at, 'mm:ss')).toBe('05:09');
    expect(fmt(dateSerial(2026, 1, 2, 0, 0, 0) as number, 'mmmmm')).toBe('J');
  });

  it('shows fractions of a second and elapsed time', () => {
    expect(fmt(1.5, '[h]:mm:ss')).toBe('36:00:00');
    expect(fmt(0.25 + 0.5 / 86400, 'h:mm:ss.00')).toBe('6:00:00.50');
    expect(fmt(2 / 1440, '[mm]:ss')).toBe('02:00');
  });

  it('shows a number that is no date in the Automatic format', () => {
    expect(fmt(-1, 'yyyy-mm-dd')).toBe('-1');
    expect(fmt(1e9, 'yyyy-mm-dd')).toBe('1000000000');
  });

  it('shows numbers in a text format in the Automatic format', () => {
    expect(fmt(12.5, '@')).toBe('12.5');
  });
});

describe('formatTextWith', () => {
  it('wraps text in the text section and shows it as it is otherwise', () => {
    expect(formatTextWith('Rent', undefined).text).toBe('Rent');
    expect(formatTextWith('Rent', '0.00').text).toBe('Rent');
    expect(formatTextWith('Rent', '0;-0;0;"Item: "@').text).toBe('Item: Rent');
    expect(formatTextWith('Rent', '@').text).toBe('Rent');
  });
});

describe('formatKind', () => {
  it('tells what a format shows', () => {
    expect(formatKind(undefined)).toBe('general');
    expect(formatKind('General')).toBe('general');
    expect(formatKind('#,##0.00')).toBe('number');
    expect(formatKind('0.0%')).toBe('percent');
    expect(formatKind('$#,##0.00')).toBe('currency');
    expect(formatKind('[$€-407]#,##0.00')).toBe('currency');
    expect(formatKind('0.00E+00')).toBe('scientific');
    expect(formatKind('yyyy-mm-dd')).toBe('date');
    expect(formatKind('h:mm AM/PM')).toBe('time');
    expect(formatKind('mm:ss')).toBe('time');
    expect(formatKind('m/d/yyyy h:mm')).toBe('datetime');
    expect(formatKind('[h]:mm:ss')).toBe('duration');
    expect(formatKind('@')).toBe('text');
  });
});

describe('changeDecimals', () => {
  it('adds or removes a decimal place in every section', () => {
    expect(changeDecimals('#,##0.00', 1, 1)).toBe('#,##0.000');
    expect(changeDecimals('#,##0.00', -1, 1)).toBe('#,##0.0');
    expect(changeDecimals('#,##0.0', -1, 1)).toBe('#,##0');
    expect(changeDecimals('#,##0', -1, 1)).toBe('#,##0');
    expect(changeDecimals('$#,##0', 1, 1)).toBe('$#,##0.0');
    expect(changeDecimals('0%', 1, 1)).toBe('0.0%');
    expect(changeDecimals('#,##0.00;(#,##0.00)', 1, 1)).toBe('#,##0.000;(#,##0.000)');
    expect(changeDecimals('0.00E+00', -1, 1)).toBe('0.0E+00');
    expect(changeDecimals('"0.0 is" 0', 1, 1)).toBe('"0.0 is" 0.0');
  });

  it('turns Automatic into a fixed number of decimals around what the value shows', () => {
    expect(changeDecimals(undefined, 1, 3.14159)).toBe('0.000000');
    expect(changeDecimals(undefined, -1, 3.14159)).toBe('0.0000');
    expect(changeDecimals(undefined, -1, 42)).toBe('0');
    expect(changeDecimals(undefined, 1, null)).toBe('0.0');
  });

  it('leaves dates, durations and text alone', () => {
    expect(changeDecimals('yyyy-mm-dd', 1, 1)).toBeNull();
    expect(changeDecimals('[h]:mm', 1, 1)).toBeNull();
    expect(changeDecimals('@', 1, 1)).toBeNull();
  });
});

describe('FORMAT_PRESETS', () => {
  it('shows a sample of each format', () => {
    const samples = Object.fromEntries(FORMAT_PRESETS.map((p) => [p.id, p.sample]));
    expect(samples).toMatchObject({
      number: '1,234.57',
      percent: '12.34%',
      scientific: '1.23E+03',
      financial: '(1,234.57)',
      currency: '$1,234.57',
      currencyRounded: '$1,235',
      date: '2026-10-17',
      dateUs: '10/17/2026',
      dateLong: 'October 17, 2026',
      time: '1:30:00 PM',
      datetime: '2026-10-17 13:30',
      duration: '36:00:00',
    });
  });
});

describe('long format codes from a file', () => {
  it('compile and format in linear time', () => {
    const started = performance.now();
    expect(fmt(1, '0' + ','.repeat(100_000))).toBe('0');
    expect(fmt(1, '0' + '.'.repeat(100_000)).length).toBeGreaterThan(0);
    expect(fmt(1234, '#' + ',#'.repeat(50_000))).toContain('1');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('still reads thousands separators and scaling commas', () => {
    expect(fmt(1234567, '#,##0')).toBe('1,234,567');
    expect(fmt(1234567, '#,,##0')).toBe('1,234,567');
    expect(fmt(1234567, '0.0,,"M"')).toBe('1.2M');
    expect(fmt(1234567, '0,')).toBe('1235');
    expect(fmt(1234.5, '#,##0.00,')).toBe('1.23');
  });
});
