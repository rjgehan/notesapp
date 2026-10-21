import { describe, expect, it } from 'vitest';
import { columnIndex, columnLetters, compareA1, compareColumns, MAX_COLUMNS, MAX_ROWS, normalizeA1, normalizeColumnKey, normalizeRowKey, parseA1, toA1 } from './a1';

describe('A1 references', () => {
  it('converts columns both ways up to XFD', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('AA')).toBe(26);
    expect(columnIndex('XFD')).toBe(MAX_COLUMNS - 1);
    expect(columnIndex('XFE')).toBe(-1);
    expect(columnIndex('a')).toBe(-1);
    expect(columnIndex('')).toBe(-1);
    for (const i of [0, 25, 26, 51, 52, 701, 702, MAX_COLUMNS - 1]) expect(columnIndex(columnLetters(i))).toBe(i);
  });

  it('parses canonical keys within the limits only', () => {
    expect(parseA1('B10')).toEqual({ col: 1, row: 9 });
    expect(parseA1(`XFD${MAX_ROWS}`)).toEqual({ col: MAX_COLUMNS - 1, row: MAX_ROWS - 1 });
    for (const bad of ['b10', '$B$10', 'A0', 'A01', `A${MAX_ROWS + 1}`, 'XFE1', 'A', '1', 'A1:B2', 'Sheet1!A1']) expect(parseA1(bad)).toBeNull();
    expect(toA1(1, 9)).toBe('B10');
  });

  it('normalizes hand-written keys', () => {
    expect(normalizeA1(' b10 ')).toBe('B10');
    expect(normalizeA1('$B$10')).toBe('B10');
    expect(normalizeA1('A0')).toBeNull();
    expect(normalizeA1('total')).toBeNull();
    expect(normalizeColumnKey('ab')).toBe('AB');
    expect(normalizeColumnKey('$C')).toBe('C');
    expect(normalizeColumnKey('A1')).toBeNull();
    expect(normalizeRowKey('007')).toBe('7');
    expect(normalizeRowKey('0')).toBeNull();
    expect(normalizeRowKey('1.5')).toBeNull();
    expect(normalizeRowKey(String(MAX_ROWS + 1))).toBeNull();
  });

  it('orders cells row by row and columns by index', () => {
    expect(['A10', 'B1', 'A2', 'AA1', 'Z1', 'A1'].sort(compareA1)).toEqual(['A1', 'B1', 'Z1', 'AA1', 'A2', 'A10']);
    expect(['AA', 'B', 'Z', 'A'].sort(compareColumns)).toEqual(['A', 'B', 'Z', 'AA']);
  });
});
