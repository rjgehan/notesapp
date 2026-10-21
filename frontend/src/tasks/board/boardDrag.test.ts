import { describe, expect, it } from 'vitest';
import { columnAt, dropAt, indexAt, isNoop, keyboardMove, type ColumnLayout } from './boardDrag';

const columns: ColumnLayout[] = [
  { id: 'a', left: 0, right: 100, mids: [20, 60] },
  { id: 'b', left: 110, right: 210, mids: [] },
  { id: 'c', left: 220, right: 320, mids: [30], locked: true },
];

describe('board drop geometry', () => {
  it('finds the column under the pointer, or the nearest one that accepts cards', () => {
    expect(columnAt(columns, 50)?.id).toBe('a');
    expect(columnAt(columns, 105)?.id).toBe('a');
    expect(columnAt(columns, 150)?.id).toBe('b');
    expect(columnAt(columns, 260)?.id).toBe('b');
    expect(columnAt(columns, -40)?.id).toBe('a');
    expect(columnAt([{ id: 'x', left: 0, right: 10, mids: [], locked: true }], 5)).toBeNull();
  });

  it('places the card before the first card whose middle is below the pointer', () => {
    expect(indexAt([20, 60], 5)).toBe(0);
    expect(indexAt([20, 60], 40)).toBe(1);
    expect(indexAt([20, 60], 90)).toBe(2);
    expect(indexAt([], 90)).toBe(0);
    expect(dropAt(columns, 50, 40)).toEqual({ column: 'a', index: 1 });
    expect(dropAt(columns, 150, 400)).toEqual({ column: 'b', index: 0 });
  });

  it('knows a drop where the card already is', () => {
    const keyed = [
      { id: 'a', keys: ['1', '2'] },
      { id: 'b', keys: [] },
    ];
    expect(isNoop(keyed, { itemKey: '2', from: 'a', to: 'a', index: 1 })).toBe(true);
    expect(isNoop(keyed, { itemKey: '2', from: 'a', to: 'a', index: 0 })).toBe(false);
    expect(isNoop(keyed, { itemKey: '2', from: 'a', to: 'b', index: 0 })).toBe(false);
  });
});

describe('keyboard moves', () => {
  const keyed = [
    { id: 'a', keys: ['1', '2', '3'] },
    { id: 'locked', keys: ['9'], locked: true },
    { id: 'b', keys: ['4'] },
  ];

  it('moves within a column, and stops at its ends', () => {
    expect(keyboardMove(keyed, '2', 'ArrowUp')).toEqual({ itemKey: '2', from: 'a', to: 'a', index: 0 });
    expect(keyboardMove(keyed, '2', 'ArrowDown')).toEqual({ itemKey: '2', from: 'a', to: 'a', index: 2 });
    expect(keyboardMove(keyed, '1', 'ArrowUp')).toBeNull();
    expect(keyboardMove(keyed, '3', 'ArrowDown')).toBeNull();
  });

  it('moves to the next column that accepts cards, at the same height or last', () => {
    expect(keyboardMove(keyed, '3', 'ArrowRight')).toEqual({ itemKey: '3', from: 'a', to: 'b', index: 1 });
    expect(keyboardMove(keyed, '4', 'ArrowLeft')).toEqual({ itemKey: '4', from: 'b', to: 'a', index: 0 });
    expect(keyboardMove(keyed, '1', 'ArrowLeft')).toBeNull();
    expect(keyboardMove(keyed, 'missing', 'ArrowLeft')).toBeNull();
  });
});
