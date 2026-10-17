import { describe, expect, it } from 'vitest';
import { compareKeys, isValidKey, keyBetween } from './fractionalIndex';

// The vectors of the fractional-indexing package, also checked by the server's FractionalIndexTest.
const VECTORS: Array<[string | null, string | null, string]> = [
  [null, null, 'a0'],
  [null, 'a0', 'Zz'],
  [null, 'Zz', 'Zy'],
  ['a0', null, 'a1'],
  ['a1', null, 'a2'],
  ['a0', 'a1', 'a0V'],
  ['a1', 'a2', 'a1V'],
  ['a0V', 'a1', 'a0l'],
  ['Zz', 'a0', 'ZzV'],
  ['Zz', 'a1', 'a0'],
  [null, 'Y00', 'Xzzz'],
  ['bzz', null, 'c000'],
  ['a0', 'a0V', 'a0G'],
  ['a0', 'a0G', 'a08'],
  ['b125', 'b129', 'b127'],
  ['a0', 'a1V', 'a1'],
  ['Zz', 'a01', 'a0'],
  [null, 'a0V', 'a0'],
  [null, 'b999', 'b99'],
  ['zzzzzzzzzzzzzzzzzzzzzzzzzzy', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzz'],
  ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzV'],
];

describe('fractional index (API.md §20.1)', () => {
  it.each(VECTORS)('between %s and %s is %s', (a, b, expected) => {
    expect(keyBetween(a, b)).toBe(expected);
  });

  it('rejects invalid keys and inverted bounds', () => {
    expect(isValidKey('a0')).toBe(true);
    expect(isValidKey('a0V')).toBe(true);
    for (const bad of ['', 'a00', '0', 'a', 'b1', 'A00000000000000000000000000', 'a0-', 'é0']) expect(isValidKey(bad)).toBe(false);
    expect(isValidKey(null)).toBe(false);
    expect(() => keyBetween('a00', null)).toThrow();
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a1', 'a1')).toThrow();
  });

  it('keeps repeated inserts ordered and distinct', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const keys = [keyBetween(null, null)];
    for (let i = 0; i < 1000; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      const key = keyBetween(at > 0 ? keys[at - 1] : null, at < keys.length ? keys[at] : null);
      expect(isValidKey(key)).toBe(true);
      keys.splice(at, 0, key);
    }
    expect([...keys].sort(compareKeys)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
