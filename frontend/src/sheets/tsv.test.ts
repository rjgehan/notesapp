import { describe, expect, it } from 'vitest';
import { formatNumber, formatValue, valueAlign } from './display';
import { parseTsv, toTsv } from './tsv';

describe('TSV', () => {
  it('writes rows and quotes fields with tabs, line breaks or quotes', () => {
    expect(toTsv([['a', 'b'], ['1', '']])).toBe('a\tb\n1\t');
    expect(toTsv([['two\nlines', 'tab\there', 'say "hi"']])).toBe('"two\nlines"\t"tab\there"\t"say ""hi"""');
  });

  it('reads what Google Sheets and Excel put on the clipboard', () => {
    expect(parseTsv('a\tb\r\n1\t2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseTsv('"two\nlines"\tx\n"say ""hi"""')).toEqual([['two\nlines', 'x'], ['say "hi"']]);
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseTsv('')).toEqual([]);
  });

  it('keeps a quote that does not open a field, and an unclosed one, as text', () => {
    expect(parseTsv('5" screen\tok')).toEqual([['5" screen', 'ok']]);
    expect(parseTsv('"open\tx')).toEqual([['"open', 'x']]);
    expect(parseTsv('"a"b\tc')).toEqual([['"a"b', 'c']]);
  });

  it('round-trips', () => {
    const rows = [
      ['x', 'tab\t', '"q"'],
      ['', 'line\r\nbreak', 'end'],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });
});

describe('display', () => {
  it('shows numbers the way Google Sheets does by default', () => {
    expect(formatNumber(1937.5)).toBe('1937.5');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.3333333333');
    expect(formatNumber(-42)).toBe('-42');
    expect(formatNumber(123456789012345)).toBe('123456789012345');
    expect(formatNumber(1e15)).toBe('1E+15');
    expect(formatNumber(1.5e20)).toBe('1.5E+20');
    expect(formatNumber(2.5e-7)).toBe('2.5E-07');
    expect(formatNumber(0.000001)).toBe('0.000001');
    expect(formatNumber(12345678901.5)).toBe('12345678902');
    expect(formatNumber(0)).toBe('0');
  });

  it('shows booleans, errors, text and empty values', () => {
    expect(formatValue(true)).toBe('TRUE');
    expect(formatValue({ e: '#DIV/0!' })).toBe('#DIV/0!');
    expect(formatValue('007')).toBe('007');
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('aligns numbers right, booleans and errors centred, text left', () => {
    expect(valueAlign(3)).toBe('right');
    expect(valueAlign(false)).toBe('center');
    expect(valueAlign({ e: '#N/A' })).toBe('center');
    expect(valueAlign('x')).toBe('left');
    expect(valueAlign(null)).toBe('left');
  });
});
