import { describe, expect, it } from 'vitest';
import { cellText } from './format';
import { numberText, typedInput } from './input';
import { dateSerial } from './numfmt';

describe('typedInput', () => {
  it('reads formulas, numbers, booleans, forced text and clears', () => {
    expect(typedInput('=SUM(A1:A3)')).toEqual({ content: { f: '=SUM(A1:A3)' } });
    expect(typedInput('=')).toEqual({ content: { v: '=' } });
    expect(typedInput('42')).toEqual({ content: { v: 42 } });
    expect(typedInput(' -1e3 ')).toEqual({ content: { v: -1000 } });
    expect(typedInput('.5')).toEqual({ content: { v: 0.5 } });
    expect(typedInput('true')).toEqual({ content: { v: true } });
    expect(typedInput("'007")).toEqual({ content: { v: '007' } });
    expect(typedInput('')).toEqual({ content: null });
    expect(typedInput('Rent ')).toEqual({ content: { v: 'Rent ' } });
  });

  it('reads percentages with the percent format they imply', () => {
    expect(typedInput('10%')).toEqual({ content: { v: 0.1 }, fmt: '0%' });
    expect(typedInput('12.5 %')).toEqual({ content: { v: 0.125 }, fmt: '0.0%' });
    expect(typedInput('-3%')).toEqual({ content: { v: -0.03 }, fmt: '0%' });
    expect(typedInput('10.1%')).toEqual({ content: { v: 0.101 }, fmt: '0.0%' });
    expect(typedInput('1,000%')).toEqual({ content: { v: 10 }, fmt: '0%' });
  });

  it('reads amounts with a currency symbol', () => {
    expect(typedInput('$1,450.50')).toEqual({ content: { v: 1450.5 }, fmt: '$#,##0.00' });
    expect(typedInput('$5')).toEqual({ content: { v: 5 }, fmt: '$#,##0.00' });
    expect(typedInput('-$5')).toEqual({ content: { v: -5 }, fmt: '$#,##0.00' });
    expect(typedInput('$-5')).toEqual({ content: { v: -5 }, fmt: '$#,##0.00' });
    expect(typedInput('€ 12')).toEqual({ content: { v: 12 }, fmt: '€#,##0.00' });
    expect(typedInput('¥1200')).toEqual({ content: { v: 1200 }, fmt: '¥#,##0' });
    expect(typedInput('-$-5')).toEqual({ content: { v: '-$-5' } });
  });

  it('reads numbers with thousands separators', () => {
    expect(typedInput('1,450')).toEqual({ content: { v: 1450 }, fmt: '#,##0' });
    expect(typedInput('-1,234,567.25')).toEqual({ content: { v: -1234567.25 }, fmt: '#,##0.00' });
    // Not thousands: kept as text.
    expect(typedInput('1,45')).toEqual({ content: { v: '1,45' } });
    expect(typedInput('12,3456')).toEqual({ content: { v: '12,3456' } });
  });

  it('reads dates and times as serial numbers with a date format', () => {
    expect(typedInput('2026-10-17')).toEqual({ content: { v: 46312 }, fmt: 'yyyy-mm-dd' });
    expect(typedInput('2026-10-17 13:30')).toEqual({ content: { v: 46312.5625 }, fmt: 'yyyy-mm-dd h:mm' });
    expect(typedInput('2026-10-17T13:30:15')).toEqual({ content: { v: dateSerial(2026, 10, 17, 13, 30, 15) }, fmt: 'yyyy-mm-dd h:mm:ss' });
    expect(typedInput('10/17/2026')).toEqual({ content: { v: 46312 }, fmt: 'm/d/yyyy' });
    expect(typedInput('1/2/26')).toEqual({ content: { v: dateSerial(2026, 1, 2) }, fmt: 'm/d/yyyy' });
    expect(typedInput('1/2/95')).toEqual({ content: { v: dateSerial(1995, 1, 2) }, fmt: 'm/d/yyyy' });
    expect(typedInput('10/17/2026 1:30 PM')).toEqual({ content: { v: 46312.5625 }, fmt: 'm/d/yyyy h:mm AM/PM' });
    expect(typedInput('13:30')).toEqual({ content: { v: 0.5625 }, fmt: 'h:mm' });
    expect(typedInput('1:30 pm')).toEqual({ content: { v: 0.5625 }, fmt: 'h:mm AM/PM' });
    expect(typedInput('12:00 AM')).toEqual({ content: { v: 0 }, fmt: 'h:mm AM/PM' });
    expect(typedInput('6:05:30')).toEqual({ content: { v: (6 * 3600 + 5 * 60 + 30) / 86400 }, fmt: 'h:mm:ss' });
  });

  it('keeps what is no date or time as text', () => {
    expect(typedInput('2026-02-30')).toEqual({ content: { v: '2026-02-30' } });
    expect(typedInput('13/17/2026')).toEqual({ content: { v: '13/17/2026' } });
    expect(typedInput('1850-01-01')).toEqual({ content: { v: '1850-01-01' } });
    expect(typedInput('25:00')).toEqual({ content: { v: '25:00' } });
    expect(typedInput('13:00 PM')).toEqual({ content: { v: '13:00 PM' } });
    expect(typedInput('10:75')).toEqual({ content: { v: '10:75' } });
  });

  it('takes everything as text in a plain-text cell', () => {
    expect(typedInput('=1+2', { plainText: true })).toEqual({ content: { v: '=1+2' } });
    expect(typedInput('007', { plainText: true })).toEqual({ content: { v: '007' } });
    expect(typedInput('', { plainText: true })).toEqual({ content: null });
  });
});

describe('numberText and cellText', () => {
  it('shows dates and times as ISO text that reads back as the same value', () => {
    for (const [text, fmt] of [
      ['2026-10-17', 'yyyy-mm-dd'],
      ['2026-10-17 13:30', 'yyyy-mm-dd h:mm'],
      ['2026-10-17 13:30:15', 'm/d/yyyy h:mm:ss'],
      ['13:30', 'h:mm AM/PM'],
    ] as const) {
      const typed = typedInput(text).content?.v as number;
      expect(numberText(typed, fmt)).toBe(text);
    }
    // A date format on a value with a time keeps the time when edited.
    expect(numberText(46312.5625, 'm/d/yyyy')).toBe('2026-10-17 13:30');
  });

  it('shows percentages as percentages and other numbers as digits', () => {
    expect(numberText(0.125, '0.0%')).toBe('12.5%');
    expect(numberText(0.101, '0%')).toBe('10.1%');
    expect(numberText(1450.5, '$#,##0.00')).toBe('1450.5');
    expect(numberText(1450.5, undefined)).toBe('1450.5');
    expect(numberText(-5, 'yyyy-mm-dd')).toBe('-5');
  });

  it('marks text that would read back as something else with a leading quote', () => {
    expect(cellText({ v: '10%' })).toBe("'10%");
    expect(cellText({ v: '2026-10-17' })).toBe("'2026-10-17");
    expect(cellText({ v: '$5' })).toBe("'$5");
    expect(cellText({ v: 'Rent' })).toBe('Rent');
    expect(cellText({ v: '10%' }, '@')).toBe('10%');
    expect(cellText({ v: 0.25 }, '0%')).toBe('25%');
  });
});
