import { describe, expect, it } from 'vitest';
import { parseSheet, type SheetFile } from './format';
import { renameSheetInFormula } from './refs';
import { resolveTarget, usedRange } from './target';

function file(value: unknown): SheetFile {
  const result = parseSheet(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

const BOOK = file({
  type: 'notesapp-sheet',
  version: 1,
  engine: '',
  sheets: [
    { id: 's1', name: 'Budget', cells: { A1: { v: 'x' }, C4: { v: 1 }, F9: { fmt: '0%' } } },
    { id: 's2', name: 'My Summary', cells: {} },
    { id: 's3', name: 'B2', cells: {} },
  ],
  named: { Total: 'Budget!$B$10', Costs: "'My Summary'!A1:B3", Rate: '0.2' },
});

describe('resolveTarget', () => {
  const at = (subpath: string | undefined) => {
    const t = resolveTarget(BOOK, subpath);
    return t && { sheet: t.sheet.name, range: t.range };
  };

  it('is the first sheet without a subpath', () => {
    expect(at(undefined)).toEqual({ sheet: 'Budget', range: null });
    expect(at('  ')).toEqual({ sheet: 'Budget', range: null });
  });

  it('finds sheets by name, in any case, before ranges', () => {
    expect(at('my summary')).toEqual({ sheet: 'My Summary', range: null });
    expect(at('B2')).toEqual({ sheet: 'B2', range: null });
  });

  it('finds ranges with and without a sheet, and named ranges', () => {
    expect(at('Budget!A1:C10')).toEqual({ sheet: 'Budget', range: { col: 0, row: 0, width: 3, height: 10 } });
    expect(at("'My Summary'!B2")).toEqual({ sheet: 'My Summary', range: { col: 1, row: 1, width: 1, height: 1 } });
    expect(at('c3:a1')).toEqual({ sheet: 'Budget', range: { col: 0, row: 0, width: 3, height: 3 } });
    expect(at('total')).toEqual({ sheet: 'Budget', range: { col: 1, row: 9, width: 1, height: 1 } });
    expect(at('Costs')).toEqual({ sheet: 'My Summary', range: { col: 0, row: 0, width: 2, height: 3 } });
  });

  it('is nothing for what the file does not have', () => {
    expect(at('Missing')).toBeNull();
    expect(at('Missing!A1')).toBeNull();
    expect(at('Rate')).toBeNull();
  });
});

describe('usedRange', () => {
  it('runs from A1 to the last cell that shows something', () => {
    expect(usedRange(BOOK.sheets[0])).toEqual({ col: 0, row: 0, width: 3, height: 4 });
    expect(usedRange(BOOK.sheets[1])).toBeNull();
  });
});

describe('renameSheetInFormula', () => {
  it('points references at the new name, quoted when needed', () => {
    expect(renameSheetInFormula('=Data!A1+data!B2', 'Data', 'Data (2)')).toBe("='Data (2)'!A1+'Data (2)'!B2");
    expect(renameSheetInFormula("='My data'!A1*2", 'My data', 'Facts')).toBe('=Facts!A1*2');
  });

  it('leaves strings, other sheets and names that only look alike alone', () => {
    expect(renameSheetInFormula('="Data!A1"&Data2!A1&MyData!A1', 'Data', 'X')).toBe('="Data!A1"&Data2!A1&MyData!A1');
    expect(renameSheetInFormula('=Data', 'Data', 'X')).toBe('=Data');
    expect(renameSheetInFormula('Data!A1', 'Data', 'X')).toBe('Data!A1');
  });
});
