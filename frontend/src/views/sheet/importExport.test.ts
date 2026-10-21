import { describe, expect, it } from 'vitest';
import { Workbook } from '../../sheets/engine';
import { cellValue, parseSheet, serializeSheet, type SheetFile } from '../../sheets/format';
import type { ImportedBook } from '../../sheets/xlsx';
import { addToWorkbook, baseName, bookToFile, csvBook, importKind } from './importExport';

function file(value: unknown): SheetFile {
  const result = parseSheet(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

const open = () =>
  Workbook.open(
    file({
      type: 'notesapp-sheet',
      version: 1,
      engine: '',
      sheets: [{ id: 's1', name: 'Data', cells: { A1: { v: 10 } } }],
      named: { Rate: '0.2' },
    }),
  );

const BOOK: ImportedBook = {
  sheets: [
    { name: 'Data', cells: { A1: { v: 5 }, B1: { f: '=A1*2', c: 10, fmt: '0.0' } }, cols: { A: { w: 150 } }, rows: { '1': { h: 30 } } },
    { name: 'Totals', cells: { A1: { f: '=Data!A1+1', c: 6 }, A2: { f: '=Rate', c: 0.5 } }, cols: {}, rows: {} },
  ],
  named: { Rate: '0.5', Base: 'Data!$A$1' },
  skipped: ['Merged cells are shown unmerged.'],
};

describe('importing into the open workbook', () => {
  it('adds the sheets as one undo step, renaming clashes and keeping their formulas right', () => {
    const wb = open();
    const { sheetId, skipped } = addToWorkbook(wb, BOOK);
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Data', 'Data (2)', 'Totals']);
    expect(sheetId).toBe(wb.file.sheets[1].id);
    const [, data, totals] = wb.file.sheets;
    expect(data.cells.B1).toEqual({ f: '=A1*2', c: 10, fmt: '0.0' });
    expect(data.cols.A).toEqual({ w: 150 });
    expect(data.rows['1']).toEqual({ h: 30 });
    // The imported formula points at the imported sheet, not at the open workbook's "Data".
    expect(totals.cells.A1).toEqual({ f: "='Data (2)'!A1+1", c: 6 });
    // The workbook's own Rate stays; the imported one is reported.
    expect(cellValue(totals.cells.A2)).toBe(0.2);
    expect(wb.file.named).toEqual({ Rate: '0.2', Base: "'Data (2)'!$A$1" });
    expect(skipped).toEqual(['Merged cells are shown unmerged.', 'The named range “Rate” already exists and was left out.']);
    wb.undo();
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Data']);
    expect(wb.file.named).toEqual({ Rate: '0.2' });
  });

  it('renames clashing sheets all at once, so renames that chain keep formulas on the right sheet', () => {
    const wb = Workbook.open(file({ type: 'notesapp-sheet', version: 1, engine: '', sheets: [{ id: 's1', name: 'Sheet1', cells: {} }], named: {} }));
    addToWorkbook(wb, {
      sheets: [
        { name: 'Sheet1', cells: { A1: { v: 111 } }, cols: {}, rows: {} },
        { name: 'Sheet1 (2)', cells: { A1: { v: 222 }, B1: { f: '=Sheet1!A1' }, C1: { f: "='Sheet1 (2)'!A1" } }, cols: {}, rows: {} },
      ],
      named: { Imported: 'Sheet1!$A$1' },
      skipped: [],
    });
    expect(wb.file.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet1 (2)', 'Sheet1 (3)']);
    const third = wb.file.sheets[2];
    expect(third.cells.B1).toEqual({ f: "='Sheet1 (2)'!A1", c: 111 });
    expect(third.cells.C1).toEqual({ f: "='Sheet1 (3)'!A1", c: 222 });
    expect(wb.file.named).toEqual({ Imported: "'Sheet1 (2)'!$A$1" });
  });

  it('imports a CSV file as one sheet named after it', () => {
    const wb = open();
    const book = csvBook('Bank export.csv', 'Date;Amount\n2026-10-17;12,5\n', ';', true);
    expect(book.sheets[0].cells).toEqual({ A1: { v: 'Date' }, B1: { v: 'Amount' }, A2: { v: 46312, fmt: 'yyyy-mm-dd' }, B2: { v: '12,5' } });
    addToWorkbook(wb, book);
    expect(wb.file.sheets[1].name).toBe('Bank export');
    expect(wb.file.sheets[1].cells.A2).toEqual({ v: 46312, fmt: 'yyyy-mm-dd' });
  });
});

describe('importing as a new file', () => {
  it('writes a file whose cached values are recalculated on first open', () => {
    const f = bookToFile(BOOK);
    expect(f.engine).toBe('');
    expect(f.sheets.map((s) => [s.id, s.name])).toEqual([
      ['s1', 'Data'],
      ['s2', 'Totals'],
    ]);
    const parsed = parseSheet(serializeSheet(f));
    expect(parsed.ok && parsed.repairs).toEqual([]);
    const wb = Workbook.open(f);
    expect(wb.stale).toBe(true);
    expect(cellValue(wb.cell('s2', 'A2'))).toBe(0.5);
  });

  it('writes an empty workbook for an empty book', () => {
    expect(bookToFile({ sheets: [], named: {}, skipped: [] }).sheets).toHaveLength(1);
  });
});

describe('file kinds', () => {
  it('tells CSV from workbooks by extension', () => {
    expect(importKind('a.CSV')).toBe('csv');
    expect(importKind('a.tsv')).toBe('csv');
    expect(importKind('a.xlsx')).toBe('workbook');
    expect(importKind('a.ods')).toBe('workbook');
    expect(importKind('a.pdf')).toBeNull();
    expect(baseName('Budget 2026.xlsx')).toBe('Budget 2026');
    expect(baseName('.hidden')).toBe('.hidden');
  });
});
