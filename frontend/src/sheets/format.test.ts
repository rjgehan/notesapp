import { describe, expect, it } from 'vitest';
import {
  cellInput,
  cellText,
  cellValue,
  formulaSheetName,
  newChartId,
  newSheetFile,
  newSheetId,
  nextSheetName,
  parseSheet,
  serializeSheet,
  sheetNameProblem,
  SHEET_ENGINE,
  type SheetFile,
} from './format';

/** The example file of ROADMAP item 6. */
const EXAMPLE = {
  type: 'notesapp-sheet',
  version: 1,
  engine: 'hyperformula@3.5.0',
  sheets: [
    {
      id: 's1',
      name: 'Budget',
      cells: {
        A1: { v: 'Item' },
        B1: { v: 'Cost' },
        A2: { v: 'Rent' },
        B2: { v: 1450 },
        B10: { f: '=SUM(B2:B9)', c: 1937.5 },
      },
      cols: { A: { w: 180 }, B: { w: 110, fmt: '$#,##0.00' } },
      rows: { '1': { bold: true } },
      frozen: { rows: 1, cols: 0 },
    },
  ],
  named: { Total: 'Budget!$B$10' },
};

function parse(value: unknown): { file: SheetFile; repairs: string[] } {
  const result = parseSheet(typeof value === 'string' ? value : JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result;
}

function refusal(value: unknown): string {
  const result = parseSheet(typeof value === 'string' ? value : JSON.stringify(value));
  if (result.ok) throw new Error('expected the file to be refused');
  return result.error;
}

const withSheet = (sheet: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'notesapp-sheet',
  version: 1,
  engine: SHEET_ENGINE,
  sheets: [{ id: 's1', name: 'Sheet1', ...sheet }],
  ...extra,
});

describe('parseSheet', () => {
  it('reads the documented example without repairs', () => {
    const { file, repairs } = parse(EXAMPLE);
    expect(repairs).toEqual([]);
    expect(file.engine).toBe('hyperformula@3.5.0');
    expect(file.sheets[0].cells.B10).toEqual({ f: '=SUM(B2:B9)', c: 1937.5 });
    expect(file.sheets[0].cols.B).toEqual({ w: 110, fmt: '$#,##0.00' });
    expect(file.sheets[0].rows['1']).toEqual({ bold: true });
    expect(file.sheets[0].frozen).toEqual({ rows: 1, cols: 0 });
    expect(file.named).toEqual({ Total: 'Budget!$B$10' });
  });

  it('keeps cached values of every kind', () => {
    const { file } = parse(withSheet({ cells: { A1: { f: '=1/0', c: { e: '#DIV/0!' } }, A2: { f: '=A99', c: null }, A3: { f: '="x"', c: 'x' }, A4: { f: '=TRUE()', c: true }, B1: { c: 2 } } }));
    const cells = file.sheets[0].cells;
    expect(cells.A1.c).toEqual({ e: '#DIV/0!' });
    expect(cells.A2.c).toBeNull();
    expect(cells.A3.c).toBe('x');
    expect(cells.A4.c).toBe(true);
    expect(cells.B1).toEqual({ c: 2 });
  });

  describe('refuses what it cannot read without losing data', () => {
    it.each([
      ['invalid JSON', '{"type": "notesapp-sheet",', /not valid JSON/],
      ['a list', [], /not a JSON object/],
      ['another type', { type: 'excalidraw' }, /not a NotesApp sheet/],
      ['a missing type', { sheets: [] }, /not a NotesApp sheet/],
      ['a newer format', { ...EXAMPLE, version: 2 }, /newer NotesApp \(format version 2\)/],
      ['an unknown version', { ...EXAMPLE, version: '1' }, /Unknown format version/],
      ['sheets that are not a list', { ...EXAMPLE, sheets: {} }, /"sheets" is not a list/],
      ['a sheet that is not an object', { ...EXAMPLE, sheets: [1] }, /Sheet 1 is not an object/],
      ['cells that are not an object', withSheet({ cells: [] }), /cells is not an object/],
      ['a cell key that is not a reference', withSheet({ cells: { total: { v: 1 } } }), /"total", which is not a valid reference/],
      ['a cell beyond the last column', withSheet({ cells: { XFE1: { v: 1 } } }), /"XFE1"/],
      ['two keys for one cell', withSheet({ cells: { a1: { v: 1 }, A1: { v: 2 } } }), /both "A1" and another key for A1|both "a1" and another key for A1/],
      ['a cell that is a list', withSheet({ cells: { A1: [1] } }), /A1 is a list/],
      ['a column key that is not a column', withSheet({ cols: { A1: { w: 1 } } }), /columns has the key "A1"/],
      ['a row key that is not a row', withSheet({ rows: { x: {} } }), /rows has the key "x"/],
      ['a column that is not an object', withSheet({ cols: { A: 120 } }), /columns A is not an object/],
      ['named ranges that are not an object', { ...EXAMPLE, named: [] }, /"named" is not an object/],
      ['a named range that is not an expression', { ...EXAMPLE, named: { X: { a: 1 } } }, /Named range "X" is not an expression/],
      ['a __proto__ key', '{"type":"notesapp-sheet","version":1,"named":{"__proto__":"x"}}', /__proto__/],
    ])('%s', (_label, value, message) => {
      expect(refusal(value)).toMatch(message);
    });

    it('marks only a newer format as newer, which the view shows read-only', () => {
      expect(parseSheet(JSON.stringify({ ...EXAMPLE, version: 2 }))).toMatchObject({ ok: false, newer: true });
      expect(parseSheet(JSON.stringify({ ...EXAMPLE, version: '1' }))).not.toHaveProperty('newer');
    });

    it('a key written twice, which JSON.parse would silently collapse', () => {
      const text = '{"type":"notesapp-sheet","version":1,"engine":"","sheets":[{"id":"s1","name":"A","cells":{"A1":{"v":1},"A1":{"v":2}}}],"named":{}}';
      expect(refusal(text)).toMatch(/"A1" appears twice/);
      // The same key in different objects is fine, and escaped quotes do not confuse the check.
      const ok = '{"type":"notesapp-sheet","version":1,"engine":"","sheets":[{"id":"s1","name":"A \\"q\\"","cells":{"A1":{"v":"x\\\\"},"A2":{"v":1}}}],"named":{}}';
      expect(parse(ok).file.sheets[0].name).toBe('A "q"');
    });
  });

  describe('repairs what it can without losing data', () => {
    it('an empty file becomes a new workbook', () => {
      const { file, repairs } = parse('  \n');
      expect(file).toEqual(newSheetFile());
      expect(repairs).toHaveLength(1);
    });

    it('strips a byte order mark', () => {
      expect(parse('﻿' + JSON.stringify(EXAMPLE)).repairs).toEqual([]);
    });

    it('fills in a missing version, engine and sheet list', () => {
      const { file, repairs } = parse({ type: 'notesapp-sheet' });
      expect(file.version).toBe(1);
      expect(file.engine).toBe('');
      expect(file.sheets).toHaveLength(1);
      expect(file.sheets[0].name).toBe('Sheet1');
      expect(repairs).toHaveLength(3);
    });

    it('normalizes cell, column and row keys', () => {
      const { file, repairs } = parse(withSheet({ cells: { b2: { v: 1 }, $C$3: { v: 2 } }, cols: { ab: { w: 50 } }, rows: { '07': { h: 30 } } }));
      expect(Object.keys(file.sheets[0].cells)).toEqual(['B2', 'C3']);
      expect(Object.keys(file.sheets[0].cols)).toEqual(['AB']);
      expect(Object.keys(file.sheets[0].rows)).toEqual(['7']);
      expect(repairs).toHaveLength(4);
    });

    it('turns bare values into cells and drops null cells', () => {
      const { file } = parse(withSheet({ cells: { A1: 5, A2: 'x', A3: true, A4: null, A5: {}, A6: { v: null } } }));
      expect(file.sheets[0].cells).toEqual({ A1: { v: 5 }, A2: { v: 'x' }, A3: { v: true } });
    });

    it('adds a missing "=" to a formula and drops an empty one', () => {
      const { file } = parse(withSheet({ cells: { A1: { f: 'SUM(B1:B2)' }, A2: { f: '  =1+1' }, A3: { f: '' }, A4: { f: '   ', v: 3 } } }));
      expect(file.sheets[0].cells.A1).toEqual({ f: '=SUM(B1:B2)' });
      expect(file.sheets[0].cells.A2).toEqual({ f: '=1+1' });
      expect(file.sheets[0].cells.A3).toBeUndefined();
      expect(file.sheets[0].cells.A4).toEqual({ v: 3 });
    });

    it('uses the formula of a cell that also has a value, and keeps the value in the file', () => {
      const { file, repairs } = parse(withSheet({ cells: { A1: { v: 4, f: '=2+2' } } }));
      expect(file.sheets[0].cells.A1).toEqual({ f: '=2+2', extra: { v: 4 } });
      expect(repairs[0]).toMatch(/both a value and a formula/);
      expect(serializeSheet(file)).toContain('"A1": { "f": "=2+2", "v": 4 }');
    });

    it('keeps unusable values verbatim instead of dropping them', () => {
      const { file, repairs } = parse(withSheet({ cells: { A1: { v: { rich: ['a', 'b'] } }, A2: { f: 12 } }, cols: { A: { w: 'wide', bold: 'yes' } }, rows: { '2': { h: -4, fmt: 7 } } }));
      expect(repairs).toHaveLength(6);
      const text = serializeSheet(file);
      expect(text).toContain('"A1": { "v": { "rich": ["a", "b"] } }');
      expect(text).toContain('"A2": { "f": 12 }');
      expect(text).toContain('"A": { "w": "wide", "bold": "yes" }');
      expect(text).toContain('"2": { "h": -4, "fmt": 7 }');
      expect(file.sheets[0].cols.A.w).toBeUndefined();
    });

    it('drops an unreadable cached value, which is recalculated', () => {
      const { file, repairs } = parse(withSheet({ cells: { A1: { f: '=1', c: { oops: 1 } }, A2: { f: '=2', c: [1] } } }));
      expect(file.sheets[0].cells.A1).toEqual({ f: '=1' });
      expect(file.sheets[0].cells.A2).toEqual({ f: '=2' });
      expect(repairs).toHaveLength(2);
    });

    it('keeps unknown keys at every level', () => {
      const raw = withSheet(
        { cells: { A1: { v: 1, s: { bg: '#fff' } } }, cols: { A: { w: 90, hidden: true } }, rows: { '1': { bold: true, wrap: 'clip' } }, rules: [{ type: 'colorScale' }] },
        { named: {}, theme: { accent: 'teal' } },
      );
      const { file, repairs } = parse(raw);
      expect(repairs).toEqual([]);
      const again = parse(serializeSheet(file)).file;
      expect(again).toEqual(file);
      expect(again.extra).toEqual({ theme: { accent: 'teal' } });
      expect(again.sheets[0].extra).toEqual({ rules: [{ type: 'colorScale' }] });
      expect(again.sheets[0].cells.A1.extra).toEqual({ s: { bg: '#fff' } });
      expect(again.sheets[0].cols.A.extra).toEqual({ hidden: true });
      expect(again.sheets[0].rows['1'].extra).toEqual({ wrap: 'clip' });
    });

    it('gives sheets unique ids and names, the same way on every device', () => {
      const raw = {
        type: 'notesapp-sheet',
        version: 1,
        engine: '',
        sheets: [{ id: 's1', name: 'Data' }, { id: 's1', name: 'data' }, { name: 42 }, { id: 7 }],
        named: {},
      };
      const { file } = parse(raw);
      expect(file.sheets.map((s) => [s.id, s.name])).toEqual([
        ['s1', 'Data'],
        ['s2', 'data (2)'],
        ['s3', '42'],
        ['s4', 'Sheet4'],
      ]);
      expect(parse(raw).file).toEqual(file);
    });

    it('normalizes named ranges and resets unusable frozen panes', () => {
      const { file } = parse({ ...EXAMPLE, named: { Total: '=Budget!$B$10', Rate: 0.2, On: true }, sheets: [{ ...EXAMPLE.sheets[0], frozen: { rows: -1, cols: 'x' } }] });
      expect(file.named).toEqual({ Total: 'Budget!$B$10', Rate: '0.2', On: 'TRUE' });
      expect(file.sheets[0].frozen).toEqual({ rows: 0, cols: 0 });
    });
  });
});

describe('serializeSheet', () => {
  it('writes the stable layout: one cell per line, row-major, sorted columns, rows and names', () => {
    const { file } = parse({
      ...withSheet({
        cells: { A10: { v: 10 }, B1: { v: 'b' }, A2: { v: 2 }, A1: { v: 'a' }, AA1: { f: '=1', c: 1 } },
        cols: { AA: { w: 1 }, B: { w: 2 } },
        rows: { '10': { h: 1 }, '2': { h: 2 } },
      }),
      named: { beta: 'Sheet1!A1', Alpha: 'Sheet1!B1' },
    });
    expect(serializeSheet(file)).toBe(`{
  "type": "notesapp-sheet",
  "version": 1,
  "engine": "${SHEET_ENGINE}",
  "sheets": [
    {
      "id": "s1",
      "name": "Sheet1",
      "cells": {
        "A1": { "v": "a" },
        "B1": { "v": "b" },
        "AA1": { "f": "=1", "c": 1 },
        "A2": { "v": 2 },
        "A10": { "v": 10 }
      },
      "cols": {
        "B": { "w": 2 },
        "AA": { "w": 1 }
      },
      "rows": {
        "2": { "h": 2 },
        "10": { "h": 1 }
      },
      "frozen": { "rows": 0, "cols": 0 }
    }
  ],
  "named": {
    "Alpha": "Sheet1!B1",
    "beta": "Sheet1!A1"
  }
}
`);
  });

  it('is stable: parsing and writing again changes nothing', () => {
    const once = serializeSheet(parse(EXAMPLE).file);
    expect(serializeSheet(parse(once).file)).toBe(once);
    expect(parse(once).file).toEqual(parse(EXAMPLE).file);
  });

  it('turns a one-cell edit into a one-line diff', () => {
    const { file } = parse(EXAMPLE);
    const before = serializeSheet(file).split('\n');
    file.sheets[0].cells.B2 = { v: 1500 };
    file.sheets[0].cells.B10 = { f: '=SUM(B2:B9)', c: 1987.5 };
    const after = serializeSheet(file).split('\n');
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual(['        "B2": { "v": 1500 },', '        "B10": { "f": "=SUM(B2:B9)", "c": 1987.5 }']);
  });

  it('writes empty collections and skips empty cells', () => {
    const file = newSheetFile();
    file.sheets[0].cells.A1 = {};
    const text = serializeSheet(file);
    expect(text).toContain('"cells": {},');
    expect(text).toContain('"named": {}\n}\n');
    expect(parse(text).file).toEqual(newSheetFile());
  });

  it('escapes names and text as JSON', () => {
    const file = newSheetFile();
    file.sheets[0].name = 'Q"1\\2';
    file.sheets[0].cells.A1 = { v: 'line\nbreak "quoted"  ' };
    expect(parse(serializeSheet(file)).file).toEqual(file);
  });
});

describe('cell input', () => {
  it.each([
    ['=SUM(A1:A3)', { f: '=SUM(A1:A3)' }],
    ['42', { v: 42 }],
    [' 3.5 ', { v: 3.5 }],
    ['-1e3', { v: -1000 }],
    ['.5', { v: 0.5 }],
    ['007', { v: 7 }],
    ['TRUE', { v: true }],
    ['false', { v: false }],
    ["'42", { v: '42' }],
    ["'=1+1", { v: '=1+1' }],
    ['=', { v: '=' }],
    ['hello', { v: 'hello' }],
    ['1e999', { v: '1e999' }],
    ['', null],
  ])('reads %j', (typed, expected) => {
    expect(cellInput(typed)).toEqual(expected);
  });

  it('shows text that would read back as something else with a leading quote', () => {
    for (const v of ['42', 'TRUE', '=1+1', "'quoted", 'plain', ' 7 ', '']) {
      const text = cellText({ v });
      expect(cellInput(text) ?? { v: '' }).toEqual({ v });
    }
    expect(cellText({ v: '42' })).toBe("'42");
    expect(cellText({ v: 'plain' })).toBe('plain');
    expect(cellText({ v: 12.5 })).toBe('12.5');
    expect(cellText({ v: false })).toBe('FALSE');
    expect(cellText({ f: '=A1', c: 3 })).toBe('=A1');
    expect(cellText({ c: 3 })).toBe('');
    expect(cellText(undefined)).toBe('');
  });

  it('shows a formula result or a literal value', () => {
    expect(cellValue({ f: '=1', c: 1 })).toBe(1);
    expect(cellValue({ f: '=1' })).toBeNull();
    expect(cellValue({ v: 'x' })).toBe('x');
    expect(cellValue({ c: 3 })).toBe(3);
    expect(cellValue(undefined)).toBeNull();
  });
});

describe('sheet names and ids', () => {
  it('validates names like a spreadsheet does', () => {
    const file = parse(EXAMPLE).file;
    expect(sheetNameProblem('Summary', file)).toBeNull();
    expect(sheetNameProblem('budget', file)).toMatch(/already a sheet/);
    expect(sheetNameProblem('budget', file, 's1')).toBeNull();
    for (const bad of ['', ' x', 'x ', 'a/b', 'a:b', 'a[1]', "'x", 'x'.repeat(101), 'a\tb']) expect(sheetNameProblem(bad, file)).not.toBeNull();
    expect(sheetNameProblem("It's", file)).toBeNull();
  });

  it('quotes names in formulas when needed', () => {
    expect(formulaSheetName('Budget')).toBe('Budget');
    expect(formulaSheetName('My Sheet')).toBe("'My Sheet'");
    expect(formulaSheetName("It's")).toBe("'It''s'");
    expect(formulaSheetName('A1')).toBe("'A1'");
    expect(formulaSheetName('2024')).toBe("'2024'");
  });

  it('makes unique ids and next names', () => {
    const file = newSheetFile();
    const ids = new Set(Array.from({ length: 50 }, () => newSheetId(file)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^s[0-9a-z]{6}$/);
    expect(nextSheetName(file)).toBe('Sheet2');
    file.sheets.push({ ...file.sheets[0], id: 's2', name: 'sheet2' });
    expect(nextSheetName(file)).toBe('Sheet3');
  });
});

describe('number formats and charts (6c)', () => {
  it('reads and writes a cell format after the value, and keeps a cell that only has one', () => {
    const { file, repairs } = parse(withSheet({ cells: { A1: { v: 0.25, fmt: '0%' }, B2: { fmt: 'yyyy-mm-dd' }, C3: { f: '=A1', c: 0.25, fmt: '0.0%' } } }));
    expect(repairs).toEqual([]);
    expect(file.sheets[0].cells).toEqual({ A1: { v: 0.25, fmt: '0%' }, B2: { fmt: 'yyyy-mm-dd' }, C3: { f: '=A1', c: 0.25, fmt: '0.0%' } });
    const text = serializeSheet(file);
    expect(text).toContain('"A1": { "v": 0.25, "fmt": "0%" },');
    expect(text).toContain('"B2": { "fmt": "yyyy-mm-dd" },');
    expect(text).toContain('"C3": { "f": "=A1", "c": 0.25, "fmt": "0.0%" }');
    expect(parse(text).file).toEqual(file);
  });

  it('keeps an unusable cell format aside', () => {
    const { file, repairs } = parse(withSheet({ cells: { A1: { v: 1, fmt: 7 } } }));
    expect(file.sheets[0].cells.A1).toEqual({ v: 1, extra: { fmt: 7 } });
    expect(repairs).toHaveLength(1);
    expect(serializeSheet(file)).toContain('"A1": { "v": 1, "fmt": 7 }');
  });

  it('reads charts keyed by id and writes them after the frozen panes, in id order', () => {
    const { file, repairs } = parse(
      withSheet({
        cells: { A1: { v: 'x' } },
        charts: {
          c2: { type: 'pie', range: 'A1:B4', title: 'Split', labels: true },
          c1: { type: 'bar', range: 'A1:C7', headers: true, labels: false, legend: 'top' },
        },
      }),
    );
    expect(repairs).toEqual([]);
    expect(file.sheets[0].charts).toEqual({
      c1: { type: 'bar', range: 'A1:C7', headers: true, labels: false, extra: { legend: 'top' } },
      c2: { type: 'pie', range: 'A1:B4', title: 'Split', labels: true },
    });
    const text = serializeSheet(file);
    expect(text).toContain(`      "frozen": { "rows": 0, "cols": 0 },
      "charts": {
        "c1": { "type": "bar", "range": "A1:C7", "headers": true, "labels": false, "legend": "top" },
        "c2": { "type": "pie", "range": "A1:B4", "title": "Split", "labels": true }
      }
    }`);
    expect(parse(text).file).toEqual(file);
  });

  it('writes no charts key for a sheet without charts, as earlier versions did', () => {
    const text = serializeSheet(parse(withSheet({ charts: {} })).file);
    expect(text).not.toContain('charts');
  });

  it('keeps unusable chart values aside and refuses a chart that is not an object', () => {
    const { file, repairs } = parse(withSheet({ charts: { c1: { type: 'donut', range: 5, title: 'T', headers: 'yes' } } }));
    expect(file.sheets[0].charts.c1).toEqual({ title: 'T', extra: { type: 'donut', range: 5, headers: 'yes' } });
    expect(repairs).toHaveLength(3);
    expect(serializeSheet(file)).toContain('"c1": { "title": "T", "type": "donut", "range": 5, "headers": "yes" }');
    expect(refusal(withSheet({ charts: { c1: 'bar' } }))).toMatch(/charts c1 is not an object/);
  });

  it('keeps a charts value that is not an object aside, written back while the sheet has no charts', () => {
    const { file, repairs } = parse(withSheet({ charts: [{ type: 'bar' }] }));
    expect(repairs).toHaveLength(1);
    expect(file.sheets[0].charts).toEqual({});
    expect(file.sheets[0].extra).toEqual({ charts: [{ type: 'bar' }] });
    const again = parse(serializeSheet(file));
    expect(again.file).toEqual(file);
  });

  it('makes chart ids that sort in the order the charts were made', () => {
    const sheet = { charts: {} };
    const first = newChartId(sheet, 1_700_000_000_000);
    const second = newChartId(sheet, 1_700_000_000_001);
    const later = newChartId(sheet, 2_000_000_000_000);
    expect([later, second, first].sort()).toEqual([first, second, later]);
    expect(first).toMatch(/^c[0-9a-z]{12}$/);
  });
});

describe('keys that are also Object.prototype members', () => {
  it('reads charts, named ranges and unknown keys called toString or constructor', () => {
    const text = JSON.stringify({
      type: 'notesapp-sheet',
      version: 1,
      engine: SHEET_ENGINE,
      sheets: [{ id: 's1', name: 'S', cells: {}, charts: { toString: { type: 'bar', range: 'A1:B2' } }, valueOf: 3 }],
      named: { constructor: 'S!$A$1' },
    });
    const result = parseSheet(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.sheets[0].charts).toEqual({ toString: { type: 'bar', range: 'A1:B2' } });
    expect(result.file.named).toEqual({ constructor: 'S!$A$1' });
    expect(parseSheet(serializeSheet(result.file))).toEqual(result);
  });
});

describe('a sheet’s structure marker', () => {
  it('is written after the charts only when set, and an unusable one is kept', () => {
    const text = (structure: unknown) =>
      JSON.stringify({ type: 'notesapp-sheet', version: 1, engine: SHEET_ENGINE, sheets: [{ id: 's1', name: 'S', cells: { A1: { v: 1 } }, structure }], named: {} });
    const set = parseSheet(text('k2x9'));
    expect(set.ok && set.file.sheets[0].structure).toBe('k2x9');
    const written = serializeSheet((set as { file: SheetFile }).file);
    expect(written).toContain('"frozen": { "rows": 0, "cols": 0 },\n      "structure": "k2x9"\n');
    expect(serializeSheet(newSheetFile())).not.toContain('structure');
    const odd = parseSheet(text(7));
    expect(odd.ok && odd.repairs).toEqual(['Sheet "S": "structure" is not text; it is kept unchanged.']);
    expect(serializeSheet((odd as { file: SheetFile }).file)).toContain('"structure": 7');
  });
});
