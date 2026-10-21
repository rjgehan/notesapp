import { HyperFormula } from 'hyperformula';
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_ID, Workbook, type WorkbookChange } from './engine';
import { cellValue, parseSheet, serializeSheet, SHEET_ENGINE, type SheetFile } from './format';
import { loadSheetEngine } from './loadEngine';

function file(value: unknown): SheetFile {
  const result = parseSheet(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

function workbook(sheets: Array<{ id?: string; name: string; cells?: Record<string, unknown> }>, named: Record<string, string> = {}, engine = ENGINE_ID): Workbook {
  return Workbook.open(file({ type: 'notesapp-sheet', version: 1, engine, sheets: sheets.map((s, i) => ({ id: s.id ?? `s${i + 1}`, ...s })), named }));
}

const value = (wb: Workbook, ref: string, sheet = 's1') => cellValue(wb.cell(sheet, ref));

/** The ROADMAP example, with more costs. */
const BUDGET = {
  type: 'notesapp-sheet',
  version: 1,
  engine: ENGINE_ID,
  sheets: [
    {
      id: 's1',
      name: 'Budget',
      cells: {
        A1: { v: 'Item' },
        B1: { v: 'Cost' },
        A2: { v: 'Rent' },
        B2: { v: 1450 },
        A3: { v: 'Food' },
        B3: { v: 487.5 },
        B10: { f: '=SUM(B2:B9)', c: 1937.5 },
      },
      cols: { A: { w: 180 }, B: { w: 110, fmt: '$#,##0.00' } },
      rows: { '1': { bold: true } },
      frozen: { rows: 1, cols: 0 },
    },
  ],
  named: { Total: 'Budget!$B$10' },
};

describe('engine identity', () => {
  it('is the pinned HyperFormula, which new files name', () => {
    expect(ENGINE_ID).toBe(`hyperformula@${HyperFormula.version}`);
    // An engine upgrade recalculates every sheet; update SHEET_ENGINE deliberately with it.
    expect(SHEET_ENGINE).toBe(ENGINE_ID);
  });

  it('runs under the GPL licence key, so functions do not return #LIC!', () => {
    const wb = workbook([{ name: 'S', cells: { A1: { f: '=SUM(1,2)' } } }]);
    expect(value(wb, 'A1')).toBe(3);
  });

  it('loads as a lazy chunk', async () => {
    const engine = await loadSheetEngine();
    expect(engine.Workbook).toBe(Workbook);
    expect(await loadSheetEngine()).toBe(engine);
  });
});

describe('Workbook round trip', () => {
  it('calculates on open and writes the cached values', () => {
    const wb = Workbook.open(file(BUDGET));
    expect(wb.stale).toBe(false);
    expect(value(wb, 'B10')).toBe(1937.5);
    const again = Workbook.open(file(JSON.parse(wb.serialize())));
    expect(again.stale).toBe(false);
    expect(again.serialize()).toBe(wb.serialize());
  });

  it('does not modify the file it was opened from', () => {
    const source = file({ ...BUDGET, engine: 'other@1' });
    const before = JSON.stringify(source);
    const wb = Workbook.open(source);
    wb.setCell('s1', 'B2', { v: 1 });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('evaluates common functions', () => {
    const wb = workbook([
      {
        name: 'S',
        cells: {
          A1: { v: 2 },
          A2: { v: 3 },
          A3: { v: 'apple' },
          B1: { f: '=A1*A2+1' },
          B2: { f: '=IF(A1>1,"big","small")' },
          B3: { f: '=VLOOKUP(3,A1:A2,1,FALSE)' },
          B4: { f: '=UPPER(A3)&"!"' },
          B5: { f: '=AVERAGE(A1:A2)' },
          B6: { f: '=ROUND(PI(),2)' },
          B7: { f: '=COUNTIF(A1:A3,">2")' },
          B8: { f: '=DATE(2026,10,17)-DATE(2026,1,1)' },
          B9: { f: '=AND(TRUE,A1=2)' },
          B10: { f: '=A99' },
        },
      },
    ]);
    expect(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10'].map((r) => value(wb, r))).toEqual([7, 'big', 3, 'APPLE!', 2.5, 3.14, 1, 289, true, null]);
  });

  it('keeps text as text, even when it looks like a number, a formula or a date', () => {
    const wb = workbook([
      {
        name: 'S',
        cells: {
          A1: { v: '007' },
          A2: { v: '=1+2' },
          A3: { v: '2026-10-17' },
          A4: { v: 'TRUE' },
          A5: { v: "'quoted" },
          B1: { f: '=ISTEXT(A1)' },
          B2: { f: '=LEN(A2)' },
          B3: { f: '=ISTEXT(A3)' },
          B4: { f: '=ISLOGICAL(A4)' },
          B5: { f: '=A5' },
        },
      },
    ]);
    expect(['B1', 'B2', 'B3', 'B4', 'B5'].map((r) => value(wb, r))).toEqual([true, 4, true, false, "'quoted"]);
    expect(wb.cell('s1', 'A2')).toEqual({ v: '=1+2' });
  });

  it('follows references across sheets, including quoted names', () => {
    const wb = workbook([
      { name: 'Main', cells: { A1: { f: "='My Data'!A1*2" }, A2: { f: "=SUM('It''s'!A1:A2)" }, A3: { f: '=Other!A1' } } },
      { name: 'My Data', cells: { A1: { v: 21 } } },
      { name: "It's", cells: { A1: { v: 1 }, A2: { v: 2 } } },
    ]);
    expect(value(wb, 'A1')).toBe(42);
    expect(value(wb, 'A2')).toBe(3);
    expect(value(wb, 'A3')).toEqual({ e: '#REF!' });
  });

  it('evaluates named ranges and constants, and reports invalid ones without dropping them', () => {
    const wb = workbook(
      [{ name: 'Budget', cells: { B2: { v: 10 }, B3: { v: 20 }, C1: { f: '=SUM(Costs)*Rate' }, C2: { f: '=Total' }, C3: { f: '=A1' }, C4: { f: '=Twice' }, B10: { f: '=SUM(B2:B9)' } } }],
      { Costs: 'Budget!$B$2:$B$9', Rate: '0.5', Total: 'Budget!$B$10', A1: '5', Twice: 'Budget!$B$2*2', twice: '3' },
    );
    expect(value(wb, 'C1')).toBe(15);
    expect(value(wb, 'C2')).toBe(30);
    expect(value(wb, 'C3')).toBeNull(); // the cell A1, not the invalid name
    expect(value(wb, 'C4')).toBe(20);
    expect(wb.problems).toHaveLength(2);
    expect(wb.problems.join(' ')).toMatch(/"A1"/);
    expect(wb.problems.join(' ')).toMatch(/"twice"/);
    expect(wb.file.named).toEqual({ Costs: 'Budget!$B$2:$B$9', Rate: '0.5', Total: 'Budget!$B$10', A1: '5', Twice: 'Budget!$B$2*2', twice: '3' });
  });

  it('stores errors as {e} with an explanation from the engine', () => {
    const wb = workbook([
      {
        name: 'S',
        cells: {
          A1: { v: 'text' },
          A2: { v: 1 },
          A3: { v: 2 },
          B1: { f: '=1/0' },
          B2: { f: '=NOSUCH(1)' },
          B3: { f: '=B3+1' },
          B4: { f: '=SUM(' },
          B5: { f: '=VLOOKUP(9,A2:A3,1,FALSE)' },
          B6: { f: '=A1+1' },
          B7: { f: '=Nowhere!A1' },
        },
      },
    ]);
    expect(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'].map((r) => value(wb, r))).toEqual([
      { e: '#DIV/0!' },
      { e: '#NAME?' },
      { e: '#CYCLE!' },
      { e: '#ERROR!' },
      { e: '#N/A' },
      { e: '#VALUE!' },
      { e: '#REF!' },
    ]);
    expect(wb.errorMessage('s1', 'B2')).toMatch(/NOSUCH/);
    expect(wb.errorMessage('s1', 'A1')).toBeNull();
    expect(wb.serialize()).toContain('"B1": { "f": "=1/0", "c": { "e": "#DIV/0!" } }');
  });

  it('caches array results in the cells they spill into', () => {
    const wb = workbook([{ name: 'S', cells: { A1: { f: '=SEQUENCE(3)' } } }]);
    expect(wb.file.sheets[0].cells).toEqual({ A1: { f: '=SEQUENCE(3)', c: 1 }, A2: { c: 2 }, A3: { c: 3 } });
    wb.setCell('s1', 'A2', { v: 'x' });
    expect(wb.file.sheets[0].cells).toEqual({ A1: { f: '=SEQUENCE(3)', c: { e: '#SPILL!' } }, A2: { v: 'x' } });
    wb.setCell('s1', 'A2', null);
    expect(wb.file.sheets[0].cells).toEqual({ A1: { f: '=SEQUENCE(3)', c: 1 }, A2: { c: 2 }, A3: { c: 3 } });
    wb.setCell('s1', 'A1', { f: '=SEQUENCE(2)' });
    expect(wb.file.sheets[0].cells).toEqual({ A1: { f: '=SEQUENCE(2)', c: 1 }, A2: { c: 2 } });
  });
  it('caches two-dimensional and neighbouring arrays', () => {
    const wb = workbook([{ name: 'S', cells: { A1: { f: '=SEQUENCE(2,2)' }, C1: { f: '=SEQUENCE(1,2,10)' }, A3: { f: '=SEQUENCE(1,1,7)' } } }]);
    expect(wb.file.sheets[0].cells).toEqual({
      A1: { f: '=SEQUENCE(2,2)', c: 1 },
      B1: { c: 2 },
      C1: { f: '=SEQUENCE(1,2,10)', c: 10 },
      D1: { c: 11 },
      A2: { c: 3 },
      B2: { c: 4 },
      A3: { f: '=SEQUENCE(1,1,7)', c: 7 },
    });
  });

  it('opens a small file with a far-away cell quickly, arrays included', () => {
    const started = performance.now();
    const far = workbook([{ name: 'S', cells: { A1: { f: '=SEQUENCE(2)' }, B1: { f: '=SUM(A:A)' }, XFD1048576: { v: 1 } } }]);
    expect(far.file.sheets[0].cells).toEqual({ A1: { f: '=SEQUENCE(2)', c: 1 }, A2: { c: 2 }, B1: { f: '=SUM(A:A)', c: 3 }, XFD1048576: { v: 1 } });
    // A column of values far to the right, next to values on the left.
    const cells: Record<string, unknown> = { A1: { f: '=SEQUENCE(3)' }, B1: { f: '=SUM(XFD1:XFD300)' } };
    for (let r = 1; r <= 300; r++) cells[`XFD${r}`] = { v: r };
    const wide = workbook([{ name: 'S', cells }]);
    expect(value(wide, 'B1')).toBe(45150);
    expect(value(wide, 'A3')).toBe(3);
    expect(performance.now() - started).toBeLessThan(5000);
    // Edits and a rebuild still work on such a sheet.
    wide.setCell('s1', 'XFD2', { v: 1000 });
    expect(value(wide, 'B1')).toBe(46148);
  });
});

describe('engine changes', () => {
  const OLD = { ...BUDGET, engine: 'hyperformula@0.0.1', sheets: [{ ...BUDGET.sheets[0], cells: { ...BUDGET.sheets[0].cells, B10: { f: '=SUM(B2:B9)', c: 999 } } }] };

  it('recalculates everything and rewrites `engine` when another engine computed the file', () => {
    const wb = Workbook.open(file(OLD));
    expect(wb.stale).toBe(true);
    expect(value(wb, 'B10')).toBe(1937.5);
    expect(wb.file.engine).toBe(ENGINE_ID);
    expect(wb.serialize()).toContain(`"engine": "${ENGINE_ID}"`);
  });

  it('treats a merged file (no engine) and missing cached values as stale', () => {
    expect(Workbook.open(file({ ...BUDGET, engine: '' })).stale).toBe(true);
    const missing = { ...BUDGET, sheets: [{ ...BUDGET.sheets[0], cells: { ...BUDGET.sheets[0].cells, B10: { f: '=SUM(B2:B9)' } } }] };
    expect(Workbook.open(file(missing)).stale).toBe(true);
    const spills = workbook([{ name: 'S', cells: { A1: { f: '=SEQUENCE(2)', c: 1 } } }]);
    expect(spills.stale).toBe(true); // A2's spilled value was missing
    expect(Workbook.open(file(JSON.parse(spills.serialize()))).stale).toBe(false);
  });

  it('does not count a volatile result as stale, so opening never dirties the file by itself', () => {
    const wb = workbook([{ name: 'S', cells: { A1: { f: '=NOW()', c: 1 } } }]);
    expect(wb.stale).toBe(false);
    expect(value(wb, 'A1')).toBeGreaterThan(40000);
  });
});

describe('edits', () => {
  it('updates dependents and tells subscribers which cells changed', () => {
    const wb = Workbook.open(file(BUDGET));
    const seen: WorkbookChange[] = [];
    wb.subscribe((c) => seen.push(c));
    wb.setCell('s1', 'B4', { v: 62.5 });
    expect(value(wb, 'B10')).toBe(2000);
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe('edit');
    expect([...(seen[0].cells?.get('s1') ?? [])].sort()).toEqual(['B10', 'B4']);
  });

  it('keeps a cell’s formatting when its content changes or is cleared', () => {
    const wb = Workbook.open(file({ ...BUDGET, sheets: [{ ...BUDGET.sheets[0], cells: { A1: { v: 1, s: { bold: true } } } }] }));
    wb.setCell('s1', 'A1', { f: '=1+1' });
    expect(wb.cell('s1', 'A1')).toEqual({ f: '=1+1', c: 2, extra: { s: { bold: true } } });
    wb.setCell('s1', 'A1', null);
    expect(wb.cell('s1', 'A1')).toEqual({ extra: { s: { bold: true } } });
  });

  it('refuses invalid edits', () => {
    const wb = Workbook.open(file(BUDGET));
    expect(() => wb.setCell('s1', 'a1', { v: 1 })).toThrow(/cell reference/);
    expect(() => wb.setCell('s1', 'A1', { f: 'SUM(1)' })).toThrow(/starts with "="/);
    expect(() => wb.setCell('nope', 'A1', { v: 1 })).toThrow(/No sheet/);
    expect(() => wb.renameSheet('s1', '')).toThrow();
    expect(() => wb.addSheet('budget')).toThrow(/already/);
    expect(() => wb.removeSheet('s1')).toThrow(/at least one sheet/);
    expect(() => wb.setNamed('B2', 'Budget!A1')).toThrow(/cannot name a range/);
    expect(() => wb.setNamed('true', '1')).toThrow(/cannot name a range/);
    expect(() => wb.setNamed('__proto__', '1')).toThrow(/cannot name a range/);
    expect(() => wb.setNamed('Broken', 'SUM(')).toThrow(/not a range/);
    expect(() => wb.setNamed('Total', 'Budget!$B$2 +')).toThrow(/not a range/);
    expect(wb.canUndo()).toBe(false);
  });

  it('adds, renames, moves and removes sheets; formulas follow renames', () => {
    const wb = Workbook.open(file(BUDGET));
    const id = wb.addSheet('Summary');
    wb.setCell(id, 'A1', { f: '=Budget!B10*2' });
    expect(value(wb, 'A1', id)).toBe(3875);
    wb.renameSheet('s1', 'Costs 2026');
    expect(wb.cell(id, 'A1')?.f).toBe("='Costs 2026'!B10*2");
    expect(wb.file.named.Total).toBe("'Costs 2026'!$B$10");
    expect(value(wb, 'A1', id)).toBe(3875);
    wb.moveSheet(id, 0);
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Summary', 'Costs 2026']);
    wb.removeSheet('s1');
    expect(value(wb, 'A1', id)).toEqual({ e: '#REF!' });
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Summary']);
  });

  it('swaps two sheet names', () => {
    const wb = workbook([
      { name: 'A', cells: { A1: { v: 1 }, B1: { f: '=B!A1' } } },
      { name: 'B', cells: { A1: { v: 2 } } },
    ]);
    wb.transact(() => {
      wb.renameSheet('s1', 'tmp');
      wb.renameSheet('s2', 'A');
      wb.renameSheet('s1', 'B');
    });
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['B', 'A']);
    expect(wb.cell('s1', 'B1')?.f).toBe('=A!A1');
    expect(value(wb, 'B1')).toBe(2);
  });

  it('changes columns, rows, frozen panes and named ranges', () => {
    const wb = Workbook.open(file(BUDGET));
    wb.setColumn('s1', 'C', { w: 90 });
    wb.setRow('s1', '1', null);
    wb.setFrozen('s1', { rows: 2, cols: 1 });
    wb.setNamed('Rent', 'Budget!$B$2');
    wb.setNamed('total', null);
    wb.setCell('s1', 'D1', { f: '=Rent/2' });
    const sheet = wb.file.sheets[0];
    expect(sheet.cols.C).toEqual({ w: 90 });
    expect(sheet.rows).toEqual({});
    expect(sheet.frozen).toEqual({ rows: 2, cols: 1 });
    expect(wb.file.named).toEqual({ Rent: 'Budget!$B$2' });
    expect(value(wb, 'D1')).toBe(725);
  });

  it('rebuilds the engine for large edits', () => {
    const wb = workbook([{ name: 'S', cells: { A1: { f: '=SUM(B1:B2000)' } } }]);
    const seen: WorkbookChange[] = [];
    wb.subscribe((c) => seen.push(c));
    wb.setCells(Array.from({ length: 2000 }, (_, i) => ({ sheet: 's1', ref: `B${i + 1}`, content: { v: 1 } })));
    expect(value(wb, 'A1')).toBe(2000);
    expect(seen[0].cells).toBeNull();
    wb.undo();
    expect(value(wb, 'A1')).toBe(0);
  });

  it('rebuilds from the model when an incremental update fails', () => {
    const wb = Workbook.open(file(BUDGET));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = vi.spyOn(HyperFormula.prototype, 'batch').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    wb.setCell('s1', 'B2', { v: 50 });
    expect(batch).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(value(wb, 'B10')).toBe(537.5);
  });
});

describe('undo and redo', () => {
  it('undoes and redoes cell edits, one step per edit or transaction', () => {
    const wb = Workbook.open(file(BUDGET));
    const original = wb.serialize();
    wb.setCell('s1', 'B2', { v: 1500 });
    wb.transact(() => {
      wb.setCell('s1', 'B3', { v: 500 });
      wb.setCell('s1', 'B4', { f: '=B3/2' });
    });
    expect(value(wb, 'B10')).toBe(2250);
    expect(wb.undo()).toBe(true);
    expect(value(wb, 'B10')).toBe(1987.5);
    expect(wb.cell('s1', 'B4')).toBeUndefined();
    expect(wb.undo()).toBe(true);
    expect(wb.serialize()).toBe(original);
    expect(wb.undo()).toBe(false);
    expect(wb.redo()).toBe(true);
    expect(wb.redo()).toBe(true);
    expect(value(wb, 'B10')).toBe(2250);
    expect(wb.canRedo()).toBe(false);
  });

  it('a new edit clears the redo history', () => {
    const wb = Workbook.open(file(BUDGET));
    wb.setCell('s1', 'B2', { v: 1 });
    wb.undo();
    expect(wb.canRedo()).toBe(true);
    wb.setCell('s1', 'B3', { v: 1 });
    expect(wb.canRedo()).toBe(false);
  });

  it('brings back a removed sheet with its cells, and formulas that referred to it', () => {
    const wb = Workbook.open(file(BUDGET));
    const id = wb.addSheet('Data');
    wb.setCells([
      { sheet: id, ref: 'A1', content: { v: 5 } },
      { sheet: id, ref: 'A2', content: { f: '=A1*2' } },
    ]);
    wb.setColumn(id, 'A', { w: 50 });
    wb.setCell('s1', 'C1', { f: '=Data!A2' });
    const before = wb.serialize();
    wb.removeSheet(id);
    expect(value(wb, 'C1')).toEqual({ e: '#REF!' });
    wb.undo();
    expect(wb.serialize()).toBe(before);
    expect(value(wb, 'C1')).toBe(10);
    wb.redo();
    expect(wb.file.sheets).toHaveLength(1);
  });

  it('undoes renames, moves, named ranges and layout', () => {
    const wb = Workbook.open(file(BUDGET));
    const original = wb.serialize();
    const id = wb.addSheet();
    wb.setCell(id, 'A1', { f: '=Budget!B10' });
    wb.renameSheet('s1', 'Costs');
    wb.moveSheet(id, 0);
    wb.setNamed('Total', 'Costs!$B$2');
    wb.setFrozen('s1', { rows: 0, cols: 0 });
    wb.setColumn('s1', 'A', null);
    while (wb.undo());
    expect(wb.serialize()).toBe(original);
    while (wb.redo());
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Sheet2', 'Costs']);
    expect(wb.cell(id, 'A1')?.f).toBe('=Costs!B10');
    expect(wb.file.named.Total).toBe('Costs!$B$2');
  });
});

describe('replace', () => {
  const edit = (wb: Workbook, change: (f: SheetFile) => void): SheetFile => {
    const next = file(JSON.parse(wb.serialize()));
    change(next);
    return next;
  };

  it('applies another device’s file and recalculates', () => {
    const wb = Workbook.open(file(BUDGET));
    const seen: WorkbookChange[] = [];
    wb.subscribe((c) => seen.push(c));
    const next = edit(wb, (f) => {
      f.sheets[0].cells.B2 = { v: 2000 };
      f.sheets[0].cols.C = { w: 10 };
      f.named.Rent = 'Budget!$B$2';
    });
    expect(wb.replace(next, { undoable: false })).toEqual({ stale: false });
    expect(value(wb, 'B10')).toBe(2487.5);
    expect(wb.file.sheets[0].cols.C).toEqual({ w: 10 });
    expect(seen.map((c) => c.origin)).toEqual(['replace']);
    expect(wb.canUndo()).toBe(false);
  });

  it('reports a replaced file with an outdated cache as stale, and nothing for an equal one', () => {
    const wb = Workbook.open(file(BUDGET));
    const seen: WorkbookChange[] = [];
    wb.subscribe((c) => seen.push(c));
    expect(wb.replace(edit(wb, () => {}), { undoable: false })).toEqual({ stale: false });
    expect(seen).toEqual([]);
    expect(wb.replace(edit(wb, (f) => (f.engine = '')), { undoable: false })).toEqual({ stale: true });
  });

  it('drops history that touches what another device changed, and keeps the rest', () => {
    const wb = Workbook.open(file(BUDGET));
    wb.setCell('s1', 'C1', { v: 'mine' });
    wb.replace(
      edit(wb, (f) => (f.sheets[0].cells.D1 = { v: 'theirs' })),
      { undoable: false },
    );
    expect(wb.canUndo()).toBe(true);
    wb.replace(
      edit(wb, (f) => (f.sheets[0].cells.C1 = { v: 'theirs too' })),
      { undoable: false },
    );
    expect(wb.canUndo()).toBe(false);
    // Undo can therefore never overwrite their C1 with a stale value.
    expect(wb.cell('s1', 'C1')).toEqual({ v: 'theirs too' });
  });

  it('drops the history of a sheet another device edited after it was added here', () => {
    const wb = Workbook.open(file(BUDGET));
    const id = wb.addSheet('New');
    wb.replace(
      edit(wb, (f) => (f.sheets[1].cells.A1 = { v: 'theirs' })),
      { undoable: false },
    );
    expect(wb.canUndo()).toBe(false);
    expect(wb.cell(id, 'A1')).toEqual({ v: 'theirs' });
  });

  it('makes Take theirs undoable', () => {
    const wb = Workbook.open(file(BUDGET));
    wb.setCell('s1', 'B2', { v: 1 });
    const mine = wb.serialize();
    wb.replace(
      edit(wb, (f) => {
        f.sheets[0].cells.B2 = { v: 2 };
        f.sheets.push({ id: 'sx', name: 'Theirs', cells: { A1: { f: '=Budget!B2' } }, cols: {}, rows: {}, frozen: { rows: 0, cols: 0 }, charts: {} });
      }),
      { undoable: true },
    );
    expect(value(wb, 'A1', 'sx')).toBe(2);
    wb.undo();
    expect(wb.serialize()).toBe(mine);
  });

  it('keeps the other device’s formula text when it renamed a sheet', () => {
    const wb = workbook([
      { name: 'Main', cells: { A1: { f: '=Data!A1' }, A2: { f: '=Data!A1+1' } } },
      { name: 'Data', cells: { A1: { v: 1 } } },
    ]);
    // Their editor renamed the sheet and updated A1 only (a hand edit, say): A2 must stay as written.
    const next = edit(wb, (f) => {
      f.sheets[1].name = 'Facts';
      f.sheets[0].cells.A1 = { f: '=Facts!A1' };
    });
    wb.replace(next, { undoable: false });
    expect(wb.cell('s1', 'A1')).toEqual({ f: '=Facts!A1', c: 1 });
    expect(wb.cell('s1', 'A2')).toEqual({ f: '=Data!A1+1', c: { e: '#REF!' } });
    expect(serializeSheet(wb.file)).toBe(serializeSheet({ ...next, engine: ENGINE_ID, sheets: wb.file.sheets }));
  });

  it('applies sheets added and removed elsewhere', () => {
    const wb = Workbook.open(file(BUDGET));
    const next = edit(wb, (f) => {
      f.sheets = [{ id: 'sy', name: 'Fresh', cells: { A1: { v: 3 }, A2: { f: '=A1*3' } }, cols: {}, rows: {}, frozen: { rows: 0, cols: 0 }, charts: {} }];
      f.named = {};
    });
    wb.replace(next, { undoable: false });
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Fresh']);
    expect(value(wb, 'A2', 'sy')).toBe(9);
  });
});

describe('number formats and charts (6c)', () => {
  it('sets and removes cell formats without touching contents or cached values', () => {
    const wb = Workbook.open(file(BUDGET));
    const seen: WorkbookChange[] = [];
    wb.subscribe((c) => seen.push(c));
    wb.setFormats([
      { sheet: 's1', ref: 'B10', fmt: '$#,##0' },
      { sheet: 's1', ref: 'C1', fmt: '0%' },
    ]);
    expect(wb.cell('s1', 'B10')).toEqual({ f: '=SUM(B2:B9)', c: 1937.5, fmt: '$#,##0' });
    expect(wb.cell('s1', 'C1')).toEqual({ fmt: '0%' });
    expect(seen).toHaveLength(1);
    expect(seen[0].cells?.get('s1')).toEqual(new Set(['B10', 'C1']));
    wb.undo();
    expect(wb.cell('s1', 'B10')).toEqual({ f: '=SUM(B2:B9)', c: 1937.5 });
    expect(wb.cell('s1', 'C1')).toBeUndefined();
    wb.redo();
    wb.setFormats([{ sheet: 's1', ref: 'C1', fmt: null }]);
    expect(wb.cell('s1', 'C1')).toBeUndefined();
    expect(() => wb.setFormats([{ sheet: 's1', ref: 'nope', fmt: '0' }])).toThrow();
  });

  it('formats a spilled value without breaking the spill', () => {
    const wb = workbook([{ name: 'S', cells: { A1: { f: '=SEQUENCE(3)' } } }]);
    wb.setFormats([{ sheet: 's1', ref: 'A2', fmt: '0.00' }]);
    expect(wb.cell('s1', 'A2')).toEqual({ c: 2, fmt: '0.00' });
    wb.setCell('s1', 'A1', { f: '=SEQUENCE(3, 1, 10, 10)' });
    expect(wb.cell('s1', 'A2')).toEqual({ c: 20, fmt: '0.00' });
    expect(value(wb, 'A3')).toBe(30);
  });

  it('keeps a cell’s format when its content changes, and takes a typed one when asked', () => {
    const wb = Workbook.open(file(BUDGET));
    wb.setFormats([{ sheet: 's1', ref: 'B2', fmt: '$#,##0.00' }]);
    wb.setCell('s1', 'B2', { v: 1500 });
    expect(wb.cell('s1', 'B2')).toEqual({ v: 1500, fmt: '$#,##0.00' });
    wb.setCell('s1', 'B2', null);
    expect(wb.cell('s1', 'B2')).toEqual({ fmt: '$#,##0.00' });
    wb.setCells([{ sheet: 's1', ref: 'B2', content: { v: 0.1 }, fmt: '0%' }]);
    expect(wb.cell('s1', 'B2')).toEqual({ v: 0.1, fmt: '0%' });
    wb.setCells([{ sheet: 's1', ref: 'B2', content: { v: 3 }, fmt: null }]);
    expect(wb.cell('s1', 'B2')).toEqual({ v: 3 });
    expect(value(wb, 'B10')).toBe(490.5);
  });

  it('adds, changes and removes charts as undoable steps', () => {
    const wb = Workbook.open(file(BUDGET));
    const id = wb.addChart('s1', { type: 'bar', range: 'A1:B3', headers: true, labels: true });
    expect(wb.file.sheets[0].charts[id]).toEqual({ type: 'bar', range: 'A1:B3', headers: true, labels: true });
    wb.setChart('s1', id, { type: 'pie', range: 'A1:B3', title: 'Split' });
    expect(wb.file.sheets[0].charts[id]).toEqual({ type: 'pie', range: 'A1:B3', title: 'Split' });
    wb.undo();
    expect(wb.file.sheets[0].charts[id].type).toBe('bar');
    wb.setChart('s1', id, null);
    expect(wb.file.sheets[0].charts).toEqual({});
    wb.undo();
    expect(Object.keys(wb.file.sheets[0].charts)).toEqual([id]);
    expect(wb.serialize()).toContain(`"${id}": { "type": "bar", "range": "A1:B3", "headers": true, "labels": true }`);
  });

  it('brings back a removed sheet’s charts and formats with it', () => {
    const wb = Workbook.open(file(BUDGET));
    const s2 = wb.addSheet('Extra');
    wb.setCells([{ sheet: s2, ref: 'A1', content: { v: 0.5 }, fmt: '0%' }]);
    const chart = wb.addChart(s2, { type: 'line', range: 'A1:A1' });
    wb.removeSheet(s2);
    expect(wb.file.sheets).toHaveLength(1);
    wb.undo();
    const back = wb.file.sheets[1];
    expect(back.cells.A1).toEqual({ v: 0.5, fmt: '0%' });
    expect(back.charts[chart]).toEqual({ type: 'line', range: 'A1:A1' });
  });

  it('takes formats and charts from another device’s file', () => {
    const wb = Workbook.open(file(BUDGET));
    const next = file(JSON.parse(wb.serialize()));
    next.sheets[0].cells.B10 = { ...next.sheets[0].cells.B10, fmt: '0.0' };
    next.sheets[0].charts = { c1: { type: 'pie', range: 'A2:B3', labels: true } };
    const seen: WorkbookChange[] = [];
    wb.subscribe((c) => seen.push(c));
    wb.replace(next, { undoable: false });
    expect(wb.cell('s1', 'B10')).toEqual({ f: '=SUM(B2:B9)', c: 1937.5, fmt: '0.0' });
    expect(wb.file.sheets[0].charts).toEqual({ c1: { type: 'pie', range: 'A2:B3', labels: true } });
    expect(seen[0].layout).toBe(true);
  });
});

describe('names that are also Object.prototype members', () => {
  const parses = (wb: Workbook) => {
    const result = parseSheet(wb.serialize());
    expect(result.ok).toBe(true);
    return result.ok ? result.file : null;
  };

  it('undoes the definition of a named range called toString or constructor', () => {
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const wb = workbook([{ name: 'Sheet1', cells: { A1: { v: 1 } } }]);
      wb.setNamed(name, 'Sheet1!$A$1');
      expect(wb.file.named[name]).toBe('Sheet1!$A$1');
      wb.undo();
      expect(Object.hasOwn(wb.file.named, name)).toBe(false);
      expect(parses(wb)?.named).toEqual({});
      wb.redo();
      expect(parses(wb)?.named).toEqual({ [name]: 'Sheet1!$A$1' });
    }
  });

  it('applies another device’s removal of such a name, and of such a chart or unknown key', () => {
    const wb = workbook([{ name: 'Sheet1', cells: { A1: { v: 1 } } }], { constructor: 'Sheet1!$A$1' });
    const base = file(JSON.parse(wb.serialize()));
    base.sheets[0].charts = { toString: { type: 'bar' as const, range: 'A1:A1' } };
    base.extra = { valueOf: 1 };
    wb.replace(base, { undoable: false });
    const next = file(JSON.parse(wb.serialize()));
    next.named = {};
    next.sheets[0].charts = {};
    delete next.extra;
    wb.replace(next, { undoable: false });
    const saved = parses(wb);
    expect(saved?.named).toEqual({});
    expect(saved?.sheets[0].charts).toEqual({});
    expect(saved?.extra).toBeUndefined();
    // And the engine no longer holds the name.
    expect(() => wb.setNamed('constructor', '2')).not.toThrow();
    expect(parses(wb)?.named).toEqual({ constructor: '2' });
  });
});
