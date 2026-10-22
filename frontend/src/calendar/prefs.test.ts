import { describe, expect, it } from 'vitest';
import { parseProperties } from './prefs';

describe('parseProperties (API.md §25.1)', () => {
  it('trims, drops empty names and repeats ignoring case, and keeps five', () => {
    expect(parseProperties(' due, Date ,, due,DATE ')).toEqual(['due', 'Date']);
    expect(parseProperties('a,b,c,d,e,f')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parseProperties('')).toEqual([]);
    expect(parseProperties('x'.repeat(65) + ',ok')).toEqual(['ok']);
  });
});
