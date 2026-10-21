import { describe, expect, it } from 'vitest';
import { absoluteRangeText, parseRangeText, rangeText, renameSheetsInFormula, shiftFormula } from './refs';

describe('shiftFormula', () => {
  it('shifts relative references and keeps absolute parts', () => {
    expect(shiftFormula('=A1+B2', 1, 0)).toBe('=A2+B3');
    expect(shiftFormula('=A1+B2', 0, 2)).toBe('=C1+D2');
    expect(shiftFormula('=$A$1+$A1+A$1', 3, 3)).toBe('=$A$1+$A4+D$1');
    expect(shiftFormula('=SUM(B2:B9)', 0, 1)).toBe('=SUM(C2:C9)');
    expect(shiftFormula('=SUM($B$2:B9)', 2, 0)).toBe('=SUM($B$2:B11)');
  });

  it('shifts whole-column and whole-row ranges', () => {
    expect(shiftFormula('=SUM(A:A)', 5, 1)).toBe('=SUM(B:B)');
    expect(shiftFormula('=SUM($A:B)', 0, 1)).toBe('=SUM($A:C)');
    expect(shiftFormula('=SUM(1:3)', 2, 4)).toBe('=SUM(3:5)');
    expect(shiftFormula('=SUM($1:3)', 2, 0)).toBe('=SUM($1:5)');
  });

  it('keeps sheet prefixes, quoted names included', () => {
    expect(shiftFormula('=Budget!B2*2', 1, 0)).toBe('=Budget!B3*2');
    expect(shiftFormula("='My sheet'!B2+'It''s'!A1:A2", 1, 1)).toBe("='My sheet'!C3+'It''s'!B2:B3");
    expect(shiftFormula('=Données!A1', 1, 0)).toBe('=Données!A2');
  });

  it('never touches strings, functions, names, numbers and booleans', () => {
    expect(shiftFormula('="A1"&A1', 1, 0)).toBe('="A1"&A2');
    expect(shiftFormula('="say ""B2"""&B2', 0, 1)).toBe('="say ""B2"""&C2');
    expect(shiftFormula('=LOG10(A1)+ATAN2(1,2)', 1, 0)).toBe('=LOG10(A2)+ATAN2(1,2)');
    expect(shiftFormula('=Total*1.5E3+2e-3', 4, 4)).toBe('=Total*1.5E3+2e-3');
    expect(shiftFormula('=IF(TRUE,A1,FALSE)', 1, 0)).toBe('=IF(TRUE,A2,FALSE)');
    expect(shiftFormula('=VLOOKUP(A1,Sheet2!A:B,2,FALSE)', 1, 0)).toBe('=VLOOKUP(A2,Sheet2!A:B,2,FALSE)');
    expect(shiftFormula('=my.name+_x', 1, 1)).toBe('=my.name+_x');
  });

  it('turns references pushed off the sheet into #REF!', () => {
    expect(shiftFormula('=A1+B2', -1, 0)).toBe('=#REF!+B1');
    expect(shiftFormula('=SUM(A1:A3)', -1, 0)).toBe('=SUM(#REF!)');
    expect(shiftFormula('=Budget!A1*2', 0, -1)).toBe('=#REF!*2');
    expect(shiftFormula('=XFD1', 0, 1)).toBe('=#REF!');
    expect(shiftFormula('=#REF!+A1', 1, 0)).toBe('=#REF!+A2');
  });

  it('upper-cases what it moves and leaves the rest as typed', () => {
    expect(shiftFormula('=sum(a1, b$2)', 1, 1)).toBe('=sum(B2, C$2)');
  });

  it('returns non-formulas and zero moves unchanged', () => {
    expect(shiftFormula('A1', 1, 1)).toBe('A1');
    expect(shiftFormula('=a1', 0, 0)).toBe('=a1');
  });
});

describe('range text', () => {
  it('writes ranges and absolute references', () => {
    expect(rangeText({ col: 1, row: 2, width: 1, height: 1 })).toBe('B3');
    expect(rangeText({ col: 0, row: 0, width: 3, height: 10 })).toBe('A1:C10');
    expect(absoluteRangeText('Budget', { col: 1, row: 1, width: 1, height: 8 })).toBe('Budget!$B$2:$B$9');
    expect(absoluteRangeText('My sheet', { col: 0, row: 0, width: 1, height: 1 })).toBe("'My sheet'!$A$1");
  });

  it('reads what is typed into the name box', () => {
    expect(parseRangeText('c10')).toEqual({ sheet: null, range: { col: 2, row: 9, width: 1, height: 1 } });
    expect(parseRangeText(' B3:A1 ')).toEqual({ sheet: null, range: { col: 0, row: 0, width: 2, height: 3 } });
    expect(parseRangeText('$B$2')).toEqual({ sheet: null, range: { col: 1, row: 1, width: 1, height: 1 } });
    expect(parseRangeText("'It''s'!A1:B2")).toEqual({ sheet: "It's", range: { col: 0, row: 0, width: 2, height: 2 } });
    expect(parseRangeText('Budget!B2')?.sheet).toBe('Budget');
    expect(parseRangeText('Total')).toBeNull();
    expect(parseRangeText('A1:B2:C3')).toBeNull();
    expect(parseRangeText('!A1')).toBeNull();
  });
});

describe('renameSheetsInFormula', () => {
  it('renames each reference once, so chained renames and swaps land right', () => {
    const chain: Array<[string, string]> = [
      ['Sheet1', 'Sheet1 (2)'],
      ['Sheet1 (2)', 'Sheet1 (3)'],
    ];
    expect(renameSheetsInFormula("=Sheet1!A1+'Sheet1 (2)'!B2+sheet1!C3", chain)).toBe("='Sheet1 (2)'!A1+'Sheet1 (3)'!B2+'Sheet1 (2)'!C3");
    const swap: Array<[string, string]> = [
      ['A', 'B'],
      ['B', 'A'],
    ];
    expect(renameSheetsInFormula('=A!A1+B!A1+"A!A1"', swap)).toBe('=B!A1+A!A1+"A!A1"');
    expect(renameSheetsInFormula('=A1+1', swap)).toBe('=A1+1');
    expect(renameSheetsInFormula('plain', swap)).toBe('plain');
  });
});
