// What `![[Budget.sheet#…]]` (and a link to `Budget.sheet#…`) points at (ROADMAP item 6b, DESIGN
// §6.21.7): nothing (the first sheet), a sheet's name (`#Summary`), a named range (`#Total`) or a
// range, with or without a sheet (`#Budget!A1:C10`, `#B2:D4` on the first sheet). Engine-free:
// embeds read the cached values of the file, and the grid opens at the same place.
import { usedExtent } from './edits';
import { sameName, sheetByName, type Sheet, type SheetFile } from './format';
import { parseRangeText, type CellRange } from './refs';

export interface SheetTarget {
  sheet: Sheet;
  /** The range; null for the sheet as a whole (its used range from A1). */
  range: CellRange | null;
}

/** The target of a subpath, or null when it names nothing in the file. */
export function resolveTarget(file: SheetFile, subpath: string | null | undefined): SheetTarget | null {
  const text = (subpath ?? '').trim();
  if (text === '') return { sheet: file.sheets[0], range: null };
  const sheet = sheetByName(file, text);
  if (sheet) return { sheet, range: null };
  const name = Object.keys(file.named).find((n) => sameName(n, text));
  const ref = parseRangeText(name !== undefined ? file.named[name] : text);
  if (!ref) return null;
  const target = ref.sheet === null ? file.sheets[0] : sheetByName(file, ref.sheet);
  return target ? { sheet: target, range: ref.range } : null;
}

/** The range a whole sheet shows: from A1 to its last used row and column (null when empty). */
export function usedRange(sheet: Sheet): CellRange | null {
  const used = usedExtent(sheet, { values: true });
  if (used.rows < 0 || used.cols < 0) return null;
  return { col: 0, row: 0, width: used.cols + 1, height: used.rows + 1 };
}
