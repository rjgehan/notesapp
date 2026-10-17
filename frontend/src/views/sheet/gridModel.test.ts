import { CompactSelection, GridCellKind, type GridSelection } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';
import { emptySheet, type Sheet } from '../../sheets/format';
import {
  cellSelection,
  clampSelection,
  DEFAULT_COLUMN_WIDTH,
  frozenRowAt,
  frozenRowTop,
  fromGridSelection,
  gridCell,
  gridColumns,
  gridLayout,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  toGridSelection,
} from './gridModel';

function sheet(extra: Partial<Sheet> = {}): Sheet {
  return { ...emptySheet('s1', 'Sheet1'), ...extra };
}

const opts = { rowHeight: 24, minRows: 0, minCols: 0, maxFrozenHeight: 1000 };

describe('grid layout', () => {
  it('shows a sheet-sized grid with room beyond the used cells', () => {
    expect(gridLayout(sheet(), opts)).toMatchObject({ rows: 1000, cols: 26, frozenRows: 0, frozenCols: 0, frozenHeight: 0 });
    const big = gridLayout(sheet({ cells: { AD2000: { v: 1 } } }), opts);
    expect(big.rows).toBe(2000 + 100);
    expect(big.cols).toBe(30 + 4);
    expect(gridLayout(sheet(), { ...opts, minRows: 5000, minCols: 40 })).toMatchObject({ rows: 5000, cols: 40 });
  });

  it('takes widths and heights from the file, within limits', () => {
    const l = gridLayout(sheet({ cols: { A: { w: 180 }, B: { w: 5 }, C: { w: 5000 } }, rows: { '2': { h: 40 } } }), opts);
    expect([0, 1, 2, 3].map(l.columnWidth)).toEqual([180, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH]);
    expect([0, 1].map(l.rowHeight)).toEqual([24, 40]);
  });

  it('freezes the rows that fit, and at least one', () => {
    const s = sheet({ frozen: { rows: 3, cols: 2 }, rows: { '2': { h: 40 } } });
    expect(gridLayout(s, opts)).toMatchObject({ frozenRows: 3, frozenCols: 2, frozenHeight: 24 + 40 + 24 });
    expect(gridLayout(s, { ...opts, maxFrozenHeight: 70 })).toMatchObject({ frozenRows: 2, frozenHeight: 64 });
    expect(gridLayout(s, { ...opts, maxFrozenHeight: 10 })).toMatchObject({ frozenRows: 1, frozenHeight: 24 });
  });

  it('finds frozen rows by height', () => {
    const l = gridLayout(sheet({ frozen: { rows: 2, cols: 0 }, rows: { '1': { h: 30 } } }), opts);
    expect([0, 29, 30, 53, 54, -1].map((y) => frozenRowAt(l, y))).toEqual([0, 0, 1, 1, null, null]);
    expect(frozenRowTop(l, 1)).toBe(30);
  });
});

describe('columns and cells', () => {
  it('names columns by letter, with file widths, live resizing and bold columns', () => {
    const s = sheet({ cols: { B: { w: 150, bold: true } } });
    const l = gridLayout(s, opts);
    const cols = gridColumns(s, l, new Map([[2, 77]]), { fontSize: 13 });
    expect(cols).toHaveLength(26);
    expect(cols.slice(0, 3).map((c) => [c.title, 'width' in c ? c.width : null])).toEqual([
      ['A', 100],
      ['B', 150],
      ['C', 77],
    ]);
    expect(cols[1].themeOverride).toEqual({ baseFontStyle: '700 13px' });
    expect(cols[0].themeOverride).toBeUndefined();
  });

  it('shows the value and edits the formula or the typed text', () => {
    const s = sheet({ cells: { A1: { f: '=1/3', c: 1 / 3 }, B1: { v: '007' }, C1: { f: '=1/0', c: { e: '#DIV/0!' } }, D1: { v: true } } });
    const o = { overlay: true, readonly: false, errorColor: '#f00' };
    expect(gridCell(s, 0, 0, o)).toMatchObject({ kind: GridCellKind.Text, data: '=1/3', displayData: '0.3333333333', contentAlign: 'right', allowOverlay: true, copyData: '0.3333333333' });
    expect(gridCell(s, 1, 0, o)).toMatchObject({ data: "'007", displayData: '007', contentAlign: 'left' });
    expect(gridCell(s, 2, 0, o)).toMatchObject({ displayData: '#DIV/0!', contentAlign: 'center', themeOverride: { textDark: '#f00' } });
    expect(gridCell(s, 3, 0, o)).toMatchObject({ data: 'TRUE', displayData: 'TRUE' });
    expect(gridCell(s, 4, 0, { ...o, overlay: false, readonly: true })).toMatchObject({ data: '', displayData: '', allowOverlay: false, readonly: true });
  });
});

describe('selections', () => {
  const frozen = gridLayout(sheet({ frozen: { rows: 2, cols: 0 } }), opts);

  it('maps grid rows below the frozen rows to sheet rows, and back', () => {
    const sel = { active: { col: 1, row: 4 }, range: { col: 1, row: 3, width: 2, height: 3 } };
    const g = toGridSelection(sel, frozen);
    expect(g.current).toMatchObject({ cell: [1, 2], range: { x: 1, y: 1, width: 2, height: 3 } });
    expect(fromGridSelection(g, frozen)).toEqual(sel);
  });

  it('has no grid selection for a frozen cell, and cuts a range at the frozen rows', () => {
    expect(toGridSelection(cellSelection(0, 1), frozen).current).toBeUndefined();
    const g = toGridSelection({ active: { col: 0, row: 2 }, range: { col: 0, row: 0, width: 1, height: 5 } }, frozen);
    expect(g.current?.range).toEqual({ x: 0, y: 0, width: 1, height: 3 });
  });

  it('turns whole columns and rows into ranges', () => {
    const none = CompactSelection.empty();
    const cols: GridSelection = { columns: CompactSelection.fromSingleSelection([2, 4]), rows: none };
    expect(fromGridSelection(cols, frozen)).toEqual({ active: { col: 2, row: 0 }, range: { col: 2, row: 0, width: 2, height: frozen.rows } });
    const rows: GridSelection = { columns: none, rows: CompactSelection.fromSingleSelection(3) };
    expect(fromGridSelection(rows, frozen)).toEqual({ active: { col: 0, row: 5 }, range: { col: 0, row: 5, width: frozen.cols, height: 1 } });
    expect(fromGridSelection({ columns: none, rows: none }, frozen)).toBeNull();
  });

  it('keeps a selection inside the grid', () => {
    const l = gridLayout(sheet(), opts);
    const inside = cellSelection(3, 3);
    expect(clampSelection(inside, l)).toBe(inside);
    expect(clampSelection(cellSelection(40, 5000), l)).toEqual(cellSelection(25, 999));
  });
});
