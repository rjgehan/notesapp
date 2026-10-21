import { describe, expect, it } from 'vitest';
import { decodeText, detectSeparator, parseCsv, rowsToCells, sheetRows, sheetToCsv, toCsv } from './csv';
import { emptySheet, type SheetCell } from './format';

describe('parseCsv', () => {
  it('reads quoted fields with separators, quotes and line breaks inside', () => {
    expect(parseCsv('Item,Note\r\n"Rent, flat","say ""hi""\nthere"\r\nGas,\n')).toEqual([
      ['Item', 'Note'],
      ['Rent, flat', 'say "hi"\nthere'],
      ['Gas', ''],
    ]);
  });

  it('keeps empty fields and rows, and text after a closing quote', () => {
    expect(parseCsv('a,,c\n\n"x"y,z', ',')).toEqual([['a', '', 'c'], [''], ['xy', 'z']]);
    expect(parseCsv('a,""', ',')).toEqual([['a', '']]);
    expect(parseCsv('', ',')).toEqual([]);
    expect(parseCsv('one\rtwo', ',')).toEqual([['one'], ['two']]);
  });

  it('reads semicolon and tab separated files', () => {
    expect(parseCsv('a;b\n1,5;2', ';')).toEqual([
      ['a', 'b'],
      ['1,5', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('detectSeparator', () => {
  it('picks the separator used most outside quotes', () => {
    expect(detectSeparator('a,b,c\n1,2,3')).toBe(',');
    expect(detectSeparator('a;b;c\n1,5;2,5;3')).toBe(';');
    expect(detectSeparator('a\tb\n"x,y,z"\t2')).toBe('\t');
    expect(detectSeparator('"a;b;c",d')).toBe(',');
    expect(detectSeparator('single')).toBe(',');
  });
});

describe('decodeText', () => {
  it('reads UTF-8 with or without a BOM, UTF-16 with a BOM, and Windows-1252 otherwise', () => {
    const utf8 = new TextEncoder().encode('Crème,brûlée');
    expect(decodeText(utf8)).toBe('Crème,brûlée');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe('Crème,brûlée');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x2c, 0x00, 0xe9, 0x00]))).toBe('A,é');
    // "Café" as Excel on Windows saves it.
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x80]))).toBe('Café€');
  });
});

describe('toCsv and sheetToCsv', () => {
  it('quotes fields that need it and ends lines with CRLF', () => {
    expect(toCsv([['a', 'b,c'], ['say "hi"', 'line\nbreak']])).toBe('a,"b,c"\r\n"say ""hi""","line\nbreak"\r\n');
    expect(toCsv([])).toBe('');
    expect(toCsv([['x;y']], ';')).toBe('"x;y"\r\n');
  });

  it('writes a sheet from A1 to its last value, as the values show', () => {
    const sheet = {
      ...emptySheet('s1', 'Budget'),
      cells: {
        A1: { v: 'Item' },
        B1: { v: 'Cost' },
        A2: { v: 'Rent' },
        B2: { v: 1450, fmt: '$#,##0.00' },
        C3: { f: '=1/0', c: { e: '#DIV/0!' } },
        D9: { fmt: '0%' },
      } as Record<string, SheetCell>,
    };
    expect(sheetRows(sheet)).toEqual([
      ['Item', 'Cost', ''],
      ['Rent', '$1,450.00', ''],
      ['', '', '#DIV/0!'],
    ]);
    expect(sheetToCsv(sheet)).toBe('Item,Cost,\r\nRent,"$1,450.00",\r\n,,#DIV/0!\r\n');
    expect(sheetToCsv(emptySheet('s1', 'Empty'))).toBe('');
  });
});

describe('rowsToCells', () => {
  it('reads fields as typed input, with the formats they imply', () => {
    const { cells, dropped } = rowsToCells(
      [
        ['Item', 'Cost', 'Share', 'Due'],
        ['Rent', '$1,450.00', '75%', '2026-10-17'],
        ['Total', '=SUM(B2:B2)', '', "'007"],
      ],
      { convert: true },
    );
    expect(dropped).toBe(0);
    expect(cells).toEqual({
      A1: { v: 'Item' },
      B1: { v: 'Cost' },
      C1: { v: 'Share' },
      D1: { v: 'Due' },
      A2: { v: 'Rent' },
      B2: { v: 1450, fmt: '$#,##0.00' },
      C2: { v: 0.75, fmt: '0%' },
      D2: { v: 46312, fmt: 'yyyy-mm-dd' },
      A3: { v: 'Total' },
      B3: { f: '=SUM(B2:B2)' },
      D3: { v: '007' },
    });
  });

  it('keeps every field as text when asked', () => {
    expect(rowsToCells([['007', '=1+1', '10%']], { convert: false }).cells).toEqual({ A1: { v: '007' }, B1: { v: '=1+1' }, C1: { v: '10%' } });
  });
});
