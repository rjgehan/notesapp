import { describe, expect, it } from 'vitest';
import { callAt, completionAt, formulaRanges, nameHint, unfinishedHint, pickSlot, placeReference, referenceText, sheetPrefix, signatureParts, suggestFunctions, type FunctionInfo, type PickedSlot } from './formulaText';

const at = (col: number, row: number, sheet: string | null = null) => ({ sheet, col, row });

describe('pointing at cells', () => {
  it('a click puts the cell in, and another click replaces it', () => {
    const first = pickSlot('=SUM(', 5, null, at(1, 1), 'click')!;
    expect(first).toEqual({ start: 5, end: 5, anchor: at(1, 1) });
    const placed = placeReference('=SUM(', first.start, first.end, first.anchor, at(1, 1));
    expect(placed).toMatchObject({ value: '=SUM(B2', caret: 7, pick: { start: 5, end: 7, text: 'B2', single: true } });
    const again = pickSlot(placed.value, placed.caret, placed.pick, at(1, 3), 'click')!;
    expect(placeReference(placed.value, again.start, again.end, again.anchor, at(1, 3)).value).toBe('=SUM(B4');
  });

  it('a second tap makes a range, a third starts again; Shift-click always extends', () => {
    let value = '=SUM(';
    let last: PickedSlot | null = null;
    const tap = (col: number, row: number, gesture: 'tap' | 'extend' = 'tap') => {
      const slot = pickSlot(value, value.length, last, at(col, row), gesture)!;
      const next = placeReference(value, slot.start, slot.end, slot.anchor, at(col, row));
      value = next.value;
      last = next.pick;
      return next;
    };
    tap(1, 1);
    expect(value).toBe('=SUM(B2');
    expect(tap(1, 3).range).toEqual({ col: 1, row: 1, width: 1, height: 3 });
    expect(value).toBe('=SUM(B2:B4');
    tap(2, 5);
    expect(value).toBe('=SUM(C6');
    tap(1, 5, 'extend');
    expect(value).toBe('=SUM(B6:C6');
    tap(0, 0, 'extend');
    expect(value).toBe('=SUM(A1:C6');
  });

  it('names another table, and a range never spans two', () => {
    expect(referenceText(at(1, 4, 'budget'), at(1, 4, 'budget'), sheetPrefix('budget', null))).toBe('budget!B5');
    expect(sheetPrefix('My table', null)).toBe("'My table'!");
    expect(sheetPrefix('Table1', 'Table1')).toBe('');
    const first = placeReference('=', 1, 1, at(1, 1, 'budget'), at(1, 1, 'budget'), 'budget!');
    const second = pickSlot(first.value, first.caret, first.pick, at(1, 2), 'tap')!;
    expect(second.anchor).toEqual(at(1, 2));
  });

  it('only where a reference can go', () => {
    expect(pickSlot('=A1', 3, null, at(0, 0), 'click')).toBeNull();
    expect(pickSlot('="a,', 4, null, at(0, 0), 'click')).toBeNull();
    expect(pickSlot('12+', 3, null, at(0, 0), 'click')).toBeNull();
    expect(pickSlot('=A1*', 4, null, at(0, 0), 'click')).not.toBeNull();
  });
});

const CATALOG: FunctionInfo[] = [
  { name: 'SUMIF', params: [{ name: 'range', optional: false }, { name: 'criterion', optional: false }, { name: 'sum_range', optional: true }], repeat: 0, rank: 8 },
  { name: 'SUM', params: [{ name: 'value', optional: false }], repeat: 1, rank: 0 },
  { name: 'SUBSTITUTE', params: [], repeat: 0 },
  { name: 'SUMSQ', params: [], repeat: 0 },
  { name: 'COUNTIFS', params: [{ name: 'criteria_range', optional: false }, { name: 'criterion', optional: false }], repeat: 2 },
];

describe('function suggestions', () => {
  it('finds the name being typed after =, an operator, a bracket or a comma', () => {
    expect(completionAt('=SU', 3)).toEqual({ from: 1, prefix: 'SU' });
    expect(completionAt('=A1+ro', 6)).toEqual({ from: 4, prefix: 'ro' });
    expect(completionAt('=IF(A1, su', 10)).toEqual({ from: 8, prefix: 'su' });
    // Not inside strings, other words, a range's second half, or before a call already written.
    expect(completionAt('="SU', 4)).toBeNull();
    expect(completionAt('=SUM(A1)SU', 10)).toBeNull();
    expect(completionAt('=A1:B', 5)).toBeNull();
    expect(completionAt('=SU(', 3)).toBeNull();
    expect(completionAt('SU', 2)).toBeNull();
  });

  it('lists the common functions first, then the shorter names', () => {
    expect(suggestFunctions(CATALOG, 'su').map((f) => f.name)).toEqual(['SUM', 'SUMIF', 'SUMSQ', 'SUBSTITUTE']);
    expect(suggestFunctions(CATALOG, 'SUM').map((f) => f.name)).toEqual(['SUMIF', 'SUMSQ']);
    expect(suggestFunctions(CATALOG, 'zz')).toEqual([]);
  });
});

describe('the signature hint', () => {
  it('finds the call and the argument the caret is in', () => {
    expect(callAt('=SUM(', 5)).toEqual({ name: 'SUM', arg: 0, open: 4 });
    expect(callAt('=ROUND(SUM(A1, A2), ', 20)).toEqual({ name: 'ROUND', arg: 1, open: 6 });
    expect(callAt('=ROUND(SUM(A1, ', 15)).toMatchObject({ name: 'SUM', arg: 1 });
    expect(callAt('=IF(A1="a,b", ', 14)).toMatchObject({ name: 'IF', arg: 1 });
    expect(callAt('=SUM((A1+', 9)).toMatchObject({ name: 'SUM', arg: 0 });
    expect(callAt('=SUM(A1)', 8)).toBeNull();
  });

  it('marks the current argument, repeated ones included', () => {
    const text = (parts: Array<{ text: string; active?: boolean }>) => parts.map((p) => (p.active ? `*${p.text}*` : p.text)).join('');
    const sum = CATALOG[1];
    expect(text(signatureParts(sum, 0))).toBe('SUM(*value1*, [value2, …])');
    expect(text(signatureParts(sum, 3))).toBe('SUM(value1, *[value2, …]*)');
    expect(text(signatureParts(CATALOG[0], 2))).toBe('SUMIF(range, criterion, *[sum_range]*)');
    expect(text(signatureParts(CATALOG[4], 1))).toBe('COUNTIFS(criteria_range1, *criterion1*, [criteria_range2, criterion2, …])');
    expect(text(signatureParts(CATALOG[4], -1))).toBe('COUNTIFS(criteria_range1, criterion1, [criteria_range2, criterion2, …])');
  });
});

describe('the cells a formula refers to', () => {
  it('lists cells, ranges, whole columns and other sheets’ references', () => {
    expect(formulaRanges('=SUM(B2:B4)*$A$1+budget!C3+AVERAGE(D:D)', { rows: 10, cols: 5 })).toEqual([
      { sheet: null, range: { col: 1, row: 1, width: 1, height: 3 } },
      { sheet: null, range: { col: 0, row: 0, width: 1, height: 1 } },
      { sheet: 'budget', range: { col: 2, row: 2, width: 1, height: 1 } },
      { sheet: null, range: { col: 3, row: 0, width: 1, height: 10 } },
    ]);
    expect(formulaRanges('plain B2')).toEqual([]);
  });
});

describe('a friendlier #NAME?', () => {
  const names = new Set(['SUM', 'SUMIF', 'AVERAGE', 'IF', 'TRUE']);
  it('suggests the call for a bare function name, and the nearest name for a misspelt one', () => {
    expect(nameHint('=SUM', names)).toBe('Did you mean SUM(…)?');
    expect(nameHint('=1+sum', names)).toBe('Did you mean SUM(…)?');
    expect(nameHint('=SUMM(A1)', names)).toBe('Unknown function SUMM. Did you mean SUM?');
    expect(nameHint('=AVERAG(A1)', names)).toBe('Unknown function AVERAG. Did you mean AVERAGE?');
    expect(nameHint('=FOOBARBAZ(A1)', names)).toBe('Unknown function FOOBARBAZ');
    // Strings, sheet names and cells are not names.
    expect(nameHint('="SUM"&A1', names)).toBeNull();
    expect(nameHint('=SUM!A1', names)).toBeNull();
    expect(nameHint('=IF(TRUE, B2)', names)).toBeNull();
  });
});

describe('a friendlier #ERROR! while a formula is typed', () => {
  it('says what an unfinished formula lacks', () => {
    expect(unfinishedHint('=SUM(B2:B4')).toBe('Missing a closing bracket )');
    expect(unfinishedHint('=ROUND(SUM(B2')).toBe('Missing 2 closing brackets )');
    expect(unfinishedHint('=B2*')).toBe('The formula is not finished');
    expect(unfinishedHint('="abc')).toBe('A text in quotes is not closed');
    expect(unfinishedHint('=SUM("(", B2)')).toBeNull();
  });
});
