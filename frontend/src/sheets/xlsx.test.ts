import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { parseSheet, type SheetFile } from './format';
import { fromExcelFormula, readWorkbook, toExcelFormula, writeWorkbook } from './xlsx';

function file(value: unknown): SheetFile {
  const result = parseSheet(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

const BUDGET = file({
  type: 'notesapp-sheet',
  version: 1,
  engine: 'hyperformula@3.4.0',
  sheets: [
    {
      id: 's1',
      name: 'Budget',
      cells: {
        A1: { v: 'Item' },
        B1: { v: 'Cost' },
        A2: { v: 'Rent' },
        B2: { v: 1450, fmt: '$#,##0.00' },
        A3: { v: 'Paid' },
        B3: { v: true },
        B4: { v: 46312, fmt: 'yyyy-mm-dd' },
        B10: { f: '=SUM(B2:B9)', c: 47762 },
        C1: { f: '=1/0', c: { e: '#DIV/0!' } },
        C2: { f: '=TEXTJOIN(", ", TRUE, A1:A3)', c: 'Item, Rent, Paid' },
        C3: { f: '="IFS(" & A1', c: 'IFS(Item' },
        D1: { f: '=SEQUENCE(3)', c: 1 },
        D2: { c: 2 },
        D3: { c: 3 },
        E1: { v: 0.25 },
      },
      cols: { A: { w: 180 }, E: { w: 60, fmt: '0%' } },
      rows: { '2': { h: 30 } },
      frozen: { rows: 1, cols: 0 },
    },
    { id: 's2', name: 'A very long sheet name that Excel cuts short', cells: { A1: { v: 5 } } },
    { id: 's3', name: 'Totals', cells: { A1: { f: "='A very long sheet name that Excel cuts short'!A1*2", c: 10 } } },
  ],
  named: { Total: 'Budget!$B$10', Rate: '0.2' },
});

describe('formulas', () => {
  it('adds the _xlfn. prefix to newer functions, outside strings and sheet names', () => {
    expect(toExcelFormula('=TEXTJOIN(",", TRUE, A1:A3)')).toBe('_xlfn.TEXTJOIN(",", TRUE, A1:A3)');
    expect(toExcelFormula('=SUM(A1) + ifs(A1>0, 1)')).toBe('SUM(A1) + _xlfn.ifs(A1>0, 1)');
    expect(toExcelFormula('="CONCAT(x)" & \'XLOOKUP(\'!A1')).toBe('"CONCAT(x)" & \'XLOOKUP(\'!A1');
    expect(toExcelFormula('=STDEV.S(A:A)')).toBe('_xlfn.STDEV.S(A:A)');
  });

  it('removes the prefixes on import', () => {
    expect(fromExcelFormula('_xlfn.TEXTJOIN(",",TRUE,A1:A3)')).toBe('=TEXTJOIN(",",TRUE,A1:A3)');
    expect(fromExcelFormula('_xlfn._xlws.FILTER(A1:A9,B1:B9>0)')).toBe('=FILTER(A1:A9,B1:B9>0)');
    expect(fromExcelFormula('"_xlfn.kept"&A1')).toBe('="_xlfn.kept"&A1');
  });
});

describe('a round trip through .xlsx', () => {
  const book = readWorkbook(writeWorkbook(BUDGET));

  it('keeps values, formulas, cached results and number formats', () => {
    const [budget] = book.sheets;
    expect(budget.name).toBe('Budget');
    expect(budget.cells.A1).toEqual({ v: 'Item' });
    expect(budget.cells.B2).toEqual({ v: 1450, fmt: '$#,##0.00' });
    expect(budget.cells.B3).toEqual({ v: true });
    expect(budget.cells.B4).toEqual({ v: 46312, fmt: 'yyyy-mm-dd' });
    expect(budget.cells.B10).toEqual({ f: '=SUM(B2:B9)', c: 47762 });
    expect(budget.cells.C1).toEqual({ f: '=1/0', c: { e: '#DIV/0!' } });
    expect(budget.cells.C2).toEqual({ f: '=TEXTJOIN(", ", TRUE, A1:A3)', c: 'Item, Rent, Paid' });
    expect(budget.cells.C3).toEqual({ f: '="IFS(" & A1', c: 'IFS(Item' });
    // A column's format is written on its cells.
    expect(budget.cells.E1).toEqual({ v: 0.25, fmt: '0%' });
  });

  it('keeps array formulas and the values they spill into', () => {
    const [budget] = book.sheets;
    expect(budget.cells.D1).toEqual({ f: '=SEQUENCE(3)', c: 1 });
    expect(budget.cells.D2).toEqual({ c: 2 });
    expect(budget.cells.D3).toEqual({ c: 3 });
  });

  it('keeps column widths, row heights and named ranges', () => {
    const [budget] = book.sheets;
    expect(budget.cols.A).toEqual({ w: 180 });
    expect(budget.cols.E).toEqual({ w: 60 });
    expect(budget.rows['2']).toEqual({ h: 30 });
    expect(book.named).toEqual({ Total: 'Budget!$B$10', Rate: '0.2' });
  });

  it('cuts sheet names to 31 characters and points formulas at the new name', () => {
    expect(book.sheets.map((s) => s.name)).toEqual(['Budget', 'A very long sheet name that Exc', 'Totals']);
    expect(book.sheets[2].cells.A1).toEqual({ f: "='A very long sheet name that Exc'!A1*2", c: 10 });
  });
});

describe('importing workbooks made elsewhere', () => {
  it('reports what it leaves out and repairs sheet names', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Score'],
      ['Ada', 0.9],
    ]);
    ws['!merges'] = [{ s: { c: 0, r: 0 }, e: { c: 1, r: 0 } }];
    ws.C1 = { t: 'e', v: 0x2a, w: '#N/A' };
    ws['!ref'] = 'A1:C2';
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1]]), 'data2');
    wb.Workbook = { Names: [{ Name: 'Local', Ref: 'Data!$A$1', Sheet: 0 }, { Name: 'Scores', Ref: 'Data!$B$2:$B$9' }] };
    const book = readWorkbook(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
    expect(book.sheets[0].cells).toEqual({ A1: { v: 'Name' }, B1: { v: 'Score' }, A2: { v: 'Ada' }, B2: { v: 0.9 }, C1: { v: '#N/A' } });
    expect(book.named).toEqual({ Scores: 'Data!$B$2:$B$9' });
    expect(book.skipped).toEqual(['Merged cells are shown unmerged.', 'The name “Local” belongs to one sheet and was left out.']);
  });

  it('refuses what is not a workbook', () => {
    expect(() => readWorkbook(new TextEncoder().encode('\u0000\u0001 not a workbook'))).toThrow();
  });
});
