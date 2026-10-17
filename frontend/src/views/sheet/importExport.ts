// Importing and exporting spreadsheets (ROADMAP item 6c, DESIGN §6.21.10): CSV into a new sheet of
// the open workbook or a new .sheet file, Excel workbooks likewise, and downloads of the current
// sheet as CSV or the workbook as .xlsx. SheetJS (sheets/xlsx.ts) loads only for workbooks.
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { openPath } from '../../features/navigation';
import { joinPath, titleOf } from '../../features/paths';
import { decodeText, detectSeparator, parseCsv, rowsToCells, sheetToCsv, type Separator } from '../../sheets/csv';
import type { CellEdit, Workbook } from '../../sheets/engine';
import { freeSheetName, sameName, serializeSheet, SHEET_TYPE, SHEET_VERSION, type Sheet, type SheetFile } from '../../sheets/format';
import { renameSheetInFormula } from '../../sheets/refs';
import type { ImportedBook } from '../../sheets/xlsx';
import { newIdempotencyKey } from '../../state/clientId';
import { applyWriteResult } from '../../sync/treePatch';

export type ImportKind = 'csv' | 'workbook';

export { IMPORT_ACCEPT } from './register';

export function importKind(name: string): ImportKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['csv', 'tsv', 'txt'].includes(ext)) return 'csv';
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) return 'workbook';
  return null;
}

/** The name of a file without its extension. */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export async function readCsvFile(file: File): Promise<{ text: string; separator: Separator }> {
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  return { text, separator: file.name.toLowerCase().endsWith('.tsv') ? '\t' : detectSeparator(text) };
}

export async function readWorkbookFile(file: File): Promise<ImportedBook> {
  const { readWorkbook } = await import('../../sheets/xlsx');
  return readWorkbook(new Uint8Array(await file.arrayBuffer()));
}

/** A CSV file as a book of one sheet, named after the file. */
export function csvBook(fileName: string, text: string, separator: Separator, convert: boolean): ImportedBook {
  const { cells, dropped } = rowsToCells(parseCsv(text, separator), { convert });
  const skipped = dropped > 0 ? [`${dropped} values beyond the sheet’s limits were left out.`] : [];
  return { sheets: [{ name: freeSheetName(baseName(fileName), []), cells, cols: {}, rows: {} }], named: {}, skipped };
}

/** The book's sheets named so that none clashes with `taken`; formulas and named ranges follow. */
function renamedFor(book: ImportedBook, taken: ReadonlyArray<{ name: string }>): ImportedBook {
  const names: Array<{ name: string }> = [...taken];
  const renames: Array<[string, string]> = [];
  for (const s of book.sheets) {
    const name = freeSheetName(s.name, names);
    names.push({ name });
    if (name !== s.name) renames.push([s.name, name]);
  }
  if (renames.length === 0) return book;
  const follow = (f: string) => renames.reduce((acc, [from, to]) => renameSheetInFormula(acc, from, to), f);
  return {
    ...book,
    sheets: book.sheets.map((s, i) => ({
      ...s,
      name: names[taken.length + i].name,
      cells: Object.fromEntries(Object.entries(s.cells).map(([ref, c]) => [ref, c.f !== undefined ? { ...c, f: follow(c.f) } : c])),
    })),
    named: Object.fromEntries(Object.entries(book.named).map(([n, e]) => [n, follow('=' + e).slice(1)])),
  };
}

/**
 * Adds the book's sheets to the open workbook as one undo step, and returns the first new sheet's
 * id and what was left out. Cached values are recalculated by the engine; named ranges whose name
 * the workbook already has are left out.
 */
export function addToWorkbook(workbook: Workbook, imported: ImportedBook): { sheetId: string; skipped: string[] } {
  const book = renamedFor(imported, workbook.file.sheets);
  const skipped = [...book.skipped];
  let first = '';
  workbook.transact(() => {
    for (const s of book.sheets) {
      const id = workbook.addSheet(s.name);
      first ||= id;
      const edits: CellEdit[] = [];
      for (const [ref, c] of Object.entries(s.cells)) {
        const content = c.f !== undefined ? { f: c.f } : c.v !== undefined ? { v: c.v } : null;
        if (content || c.fmt) edits.push({ sheet: id, ref, content, ...(c.fmt ? { fmt: c.fmt } : {}) });
      }
      workbook.setCells(edits);
      for (const [key, props] of Object.entries(s.cols)) workbook.setColumn(id, key, props);
      for (const [key, props] of Object.entries(s.rows)) workbook.setRow(id, key, props);
    }
    for (const [name, expression] of Object.entries(book.named)) {
      if (Object.keys(workbook.file.named).some((n) => sameName(n, name))) {
        skipped.push(`The named range “${name}” already exists and was left out.`);
        continue;
      }
      try {
        workbook.setNamed(name, expression);
      } catch {
        skipped.push(`The named range “${name}” could not be read and was left out.`);
      }
    }
  });
  return { sheetId: first, skipped };
}

/** The book as a new .sheet file; its cached values are recalculated when it first opens. */
export function bookToFile(book: ImportedBook): SheetFile {
  const sheets: Sheet[] = book.sheets.map((s, i) => ({ id: `s${i + 1}`, name: s.name, cells: s.cells, cols: s.cols, rows: s.rows, frozen: { rows: 0, cols: 0 }, charts: {} }));
  if (sheets.length === 0) sheets.push({ id: 's1', name: 'Sheet1', cells: {}, cols: {}, rows: {}, frozen: { rows: 0, cols: 0 }, charts: {} });
  // engine "": no engine computed these values here, so the first open recalculates them.
  return { type: SHEET_TYPE, version: SHEET_VERSION, engine: '', sheets, named: book.named };
}

/** Creates `<folder>/<name>.sheet` (or `<name> 1.sheet`, …) with `file` and opens it. */
export async function createSheetFile(folder: string, name: string, file: SheetFile): Promise<string> {
  const content = serializeSheet(file);
  const result = await api.createFile({ path: joinPath(folder, `${name}.sheet`), content, onConflict: 'rename' }, { idempotencyKey: newIdempotencyKey() });
  applyWriteResult(queryClient, result, content);
  openPath(result.file.path);
  return result.file.path;
}

/** Saves `data` as a download called `name`. */
export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari starts the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The current sheet as CSV, its values as they show: `Budget.csv`, or `Budget - Summary.csv` in a workbook of several sheets. */
export function exportCsv(path: string, file: SheetFile, sheet: Sheet): void {
  const name = file.sheets.length > 1 ? `${titleOf(path)} - ${sheet.name}` : titleOf(path);
  download(`${name}.csv`, sheetToCsv(sheet), 'text/csv;charset=utf-8');
}

/** The workbook as `Budget.xlsx`. */
export async function exportXlsx(path: string, file: SheetFile): Promise<void> {
  const { writeWorkbook } = await import('../../sheets/xlsx');
  download(`${titleOf(path)}.xlsx`, writeWorkbook(file) as BlobPart, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
