import { describe, expect, it } from 'vitest';
import { fillCells, fillTarget } from './fill';

const ROWS = [
  ['A', 'B', 'C'],
  ['1', '=A2*2', '=$A$2+A2'],
  ['2', '', 'x'],
  ['', '', ''],
  ['', '', ''],
];

describe('fill in tables', () => {
  it('shifts relative references and keeps absolute ones', () => {
    expect(fillCells(ROWS, { row: 1, column: 1, height: 1, width: 2 }, { row: 1, column: 1, height: 3, width: 2 })).toEqual([
      { row: 2, column: 1, text: '=A3*2' },
      { row: 2, column: 2, text: '=$A$2+A3' },
      { row: 3, column: 1, text: '=A4*2' },
      { row: 3, column: 2, text: '=$A$2+A4' },
    ]);
    expect(fillCells(ROWS, { row: 1, column: 1, height: 1, width: 1 }, { row: 1, column: 1, height: 1, width: 2 })).toEqual([{ row: 1, column: 2, text: '=B2*2' }]);
  });

  it('continues number series, copies a single number and text, and repeats a block', () => {
    expect(fillCells(ROWS, { row: 1, column: 0, height: 2, width: 1 }, { row: 1, column: 0, height: 4, width: 1 })).toEqual([
      { row: 3, column: 0, text: '3' },
      { row: 4, column: 0, text: '4' },
    ]);
    expect(fillCells([['h'], ['0.5'], ['1'], ['']], { row: 1, column: 0, height: 2, width: 1 }, { row: 1, column: 0, height: 3, width: 1 })).toEqual([{ row: 3, column: 0, text: '1.5' }]);
    expect(fillCells(ROWS, { row: 1, column: 0, height: 1, width: 1 }, { row: 1, column: 0, height: 3, width: 1 }).map((e) => e.text)).toEqual(['1', '1']);
    // A column of the source that is not all numbers repeats.
    expect(fillCells(ROWS, { row: 1, column: 2, height: 2, width: 1 }, { row: 1, column: 2, height: 4, width: 1 }).map((e) => e.text)).toEqual(['=$A$2+A4', 'x']);
    // Up: the series runs backwards.
    expect(fillCells([['h'], [''], ['5'], ['6']], { row: 2, column: 0, height: 2, width: 1 }, { row: 1, column: 0, height: 3, width: 1 })).toEqual([{ row: 1, column: 0, text: '4' }]);
  });

  it('a fill-handle drag fills the way the pointer went further, within the table, never into the header', () => {
    const source = { row: 1, column: 1, height: 1, width: 1 };
    expect(fillTarget(source, 1, 1, 5, 3)).toBeNull();
    expect(fillTarget(source, 3, 2, 5, 3)).toEqual({ row: 1, column: 1, height: 3, width: 1 });
    expect(fillTarget(source, 2, 2, 5, 3)).toEqual({ row: 1, column: 1, height: 2, width: 1 });
    expect(fillTarget(source, 1, 9, 5, 3)).toEqual({ row: 1, column: 1, height: 1, width: 2 });
    expect(fillTarget(source, 0, 1, 5, 3)).toBeNull();
    expect(fillTarget({ row: 3, column: 1, height: 1, width: 1 }, 0, 1, 5, 3)).toEqual({ row: 1, column: 1, height: 3, width: 1 });
    expect(fillTarget(source, 1, 0, 5, 3)).toEqual({ row: 1, column: 0, height: 1, width: 2 });
  });
});
