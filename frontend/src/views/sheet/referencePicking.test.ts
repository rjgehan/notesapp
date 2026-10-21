import { describe, expect, it } from 'vitest';
import { referenceSlot, spanOf } from './referencePicking';

describe('where a pointed-at reference goes', () => {
  it('goes where a reference can follow, and nowhere else', () => {
    expect(referenceSlot('=', 1, null)).toEqual({ start: 1, end: 1 });
    expect(referenceSlot('=SUM(', 5, null)).toEqual({ start: 5, end: 5 });
    expect(referenceSlot('=A1+', 4, null)).toEqual({ start: 4, end: 4 });
    expect(referenceSlot('=SUM(A1, ', 9, null)).toEqual({ start: 9, end: 9 });
    expect(referenceSlot('=SUM(A1:', 8, null)).toEqual({ start: 8, end: 8 });
    // The caret in the middle: what is before it counts.
    expect(referenceSlot('=SUM()', 5, null)).toEqual({ start: 5, end: 5 });
    // After a complete operand, inside a string, or not a formula: the click ends the edit.
    expect(referenceSlot('=A1', 3, null)).toBeNull();
    expect(referenceSlot('=SUM(A1)', 8, null)).toBeNull();
    expect(referenceSlot('="a,', 4, null)).toBeNull();
    expect(referenceSlot('12+', 3, null)).toBeNull();
  });

  it('replaces the reference pointing inserted last while the caret is still after it', () => {
    const last = { start: 5, end: 7, text: 'B2' };
    expect(referenceSlot('=SUM(B2', 7, last)).toEqual({ start: 5, end: 7 });
    // Typed on since, or edited: a new place.
    expect(referenceSlot('=SUM(B2+', 8, last)).toEqual({ start: 8, end: 8 });
    expect(referenceSlot('=SUM(B3', 7, last)).toBeNull();
  });

  it('spans two cells either way round', () => {
    expect(spanOf({ col: 3, row: 5 }, { col: 1, row: 2 })).toEqual({ col: 1, row: 2, width: 3, height: 4 });
  });
});
