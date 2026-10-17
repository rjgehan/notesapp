// CSV import and export (ROADMAP item 6c, DESIGN §6.21.10). Export writes a sheet's values as they
// show, RFC 4180 style: comma-separated, CRLF line ends, a field with the separator, a quote or a
// line break quoted with the quote doubled. Import reads UTF-8 (with or without a BOM), UTF-16
// with a BOM, or else Windows-1252; detects the separator (comma, semicolon or tab); and turns the
// rows into cells as if they had been typed, or as plain text. Engine-free.
import { toA1, MAX_COLUMNS, MAX_ROWS } from './a1';
import { shownCell } from './display';
import { usedExtent } from './edits';
import type { Sheet, SheetCell } from './format';
import { typedInput } from './input';

export type Separator = ',' | ';' | '\t';

/** The text of an imported file: UTF-8, UTF-16 with a byte order mark, or Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Excel on Windows saves "CSV" in the system code page.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The separator a file uses: the one that occurs most often outside quotes in its first lines. */
export function detectSeparator(text: string): Separator {
  const counts: Record<Separator, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 20; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
    else if (!quoted && ch === '\n') lines++;
  }
  if (counts['\t'] > 0 && counts['\t'] >= counts[','] && counts['\t'] >= counts[';']) return '\t';
  return counts[';'] > counts[','] ? ';' : ',';
}

/**
 * Rows of fields. A field that starts with a quote runs to the closing quote (separators and line
 * breaks inside are text, `""` is a quote); text after the closing quote is kept. CRLF, LF and CR
 * end a row; a final line break adds no empty row.
 */
export function parseCsv(text: string, separator: Separator = detectSeparator(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let fieldStart = true;
  const endField = () => {
    row.push(field);
    field = '';
    fieldStart = true;
  };
  while (i < text.length) {
    const ch = text[i];
    if (fieldStart && ch === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += text[i++];
      }
      fieldStart = false;
      continue;
    }
    fieldStart = false;
    if (ch === separator) {
      endField();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endField();
      rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length > 0 || !fieldStart) {
    endField();
    rows.push(row);
  }
  return rows;
}

function quoteField(field: string, separator: Separator): string {
  return field.includes(separator) || /["\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function toCsv(rows: readonly (readonly string[])[], separator: Separator = ','): string {
  return rows.map((r) => r.map((f) => quoteField(f, separator)).join(separator)).join('\r\n') + (rows.length > 0 ? '\r\n' : '');
}

/** A sheet's used cells from A1 as text, each value as it shows in its number format. */
export function sheetRows(sheet: Sheet): string[][] {
  const used = usedExtent(sheet, { values: true });
  const rows: string[][] = [];
  for (let row = 0; row <= used.rows; row++) {
    const line: string[] = [];
    for (let col = 0; col <= used.cols; col++) line.push(shownCell(sheet, col, row).text);
    rows.push(line);
  }
  return rows;
}

/** The sheet as a CSV file. */
export function sheetToCsv(sheet: Sheet): string {
  return toCsv(sheetRows(sheet));
}

export interface ImportOptions {
  /** Read numbers, dates and formulas as if typed (true), or keep every field as text. */
  convert: boolean;
}

/**
 * Cells from rows of text: each field as typed input (with the number format it implies), or as
 * text. Empty fields stay empty; rows and columns beyond the sheet's limits are left out (counted
 * in `dropped`).
 */
export function rowsToCells(rows: readonly (readonly string[])[], opts: ImportOptions): { cells: Record<string, SheetCell>; dropped: number } {
  const cells: Record<string, SheetCell> = {};
  let dropped = 0;
  rows.forEach((line, row) => {
    line.forEach((text, col) => {
      if (text === '') return;
      if (row >= MAX_ROWS || col >= MAX_COLUMNS) {
        dropped++;
        return;
      }
      const typed = opts.convert ? typedInput(text) : { content: { v: text } };
      if (!typed.content) return;
      const cell: SheetCell = { ...typed.content };
      if ('fmt' in typed && typed.fmt) cell.fmt = typed.fmt;
      cells[toA1(col, row)] = cell;
    });
  });
  return { cells, dropped };
}
