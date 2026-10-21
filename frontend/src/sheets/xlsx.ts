// Excel workbooks (ROADMAP item 6c, DESIGN §6.21.10) through SheetJS Community Edition, installed
// from cdn.sheetjs.com (pinned, with its integrity hash in the lockfile; never the npm registry's
// frozen `xlsx`). A lazy chunk: only an import or export of a workbook loads it.
//
// Carried over both ways: values, formulas (`_xlfn.` prefixes removed on import and added on
// export), the cached results of formulas, number formats, column widths, row heights and
// workbook-level named ranges. Array formulas come in as formulas whose values spill (recalculated
// on open). Not carried: styles other than number formats, merged cells, comments, frozen panes,
// charts and sheet-scoped names; import() reports what it left out.
import * as XLSX from 'xlsx';
import { columnIndex, columnLetters, parseA1, toA1, MAX_COLUMNS, MAX_ROWS } from './a1';
import { effectiveFormat } from './display';
import { cellValue, freeSheetName, isCellError, type CachedValue, type ColumnProps, type RowProps, type SheetCell, type SheetFile } from './format';
import { isGeneral } from './numfmt';
import { renameSheetsInFormula } from './refs';

export interface ImportedSheet {
  name: string;
  cells: Record<string, SheetCell>;
  cols: Record<string, ColumnProps>;
  rows: Record<string, RowProps>;
}

export interface ImportedBook {
  sheets: ImportedSheet[];
  named: Record<string, string>;
  /** What could not be brought over, for the user. */
  skipped: string[];
}

/** Functions Excel stores with the `_xlfn.` prefix (introduced after Excel 2007). */
const FUTURE_FUNCTIONS = new Set(
  (
    'ACOT ACOTH AGGREGATE ARABIC BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR ' +
    'CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T ' +
    'COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST ' +
    'FILTER FLOOR.MATH FLOOR.PRECISE FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS HYPGEOM.DIST IFNA IFS IMCOSH IMCOT ' +
    'IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOWEEKNUM LET LOGNORM.DIST LOGNORM.INV MAXIFS MINIFS MODE.MULT MODE.SNGL ' +
    'NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC ' +
    'PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC RANDARRAY RANK.AVG RANK.EQ SEC SECH SEQUENCE SHEET SHEETS ' +
    'SKEW.P SORT SORTBY STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TEXTJOIN UNICHAR UNICODE UNIQUE VAR.P ' +
    'VAR.S WEIBULL.DIST WORKDAY.INTL XLOOKUP XMATCH XOR Z.TEST'
  ).split(' '),
);

/** Error codes as Excel stores them. */
const ERROR_CODES: Record<string, number> = {
  '#NULL!': 0x00,
  '#DIV/0!': 0x07,
  '#VALUE!': 0x0f,
  '#REF!': 0x17,
  '#NAME?': 0x1d,
  '#NUM!': 0x24,
  '#N/A': 0x2a,
  '#GETTING_DATA': 0x2b,
};

/** Applies `fn` to the parts of a formula outside strings and quoted sheet names. */
function outsideQuotes(formula: string, fn: (part: string) => string): string {
  let out = '';
  let part = '';
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (ch !== '"' && ch !== "'") {
      part += ch;
      continue;
    }
    out += fn(part);
    part = '';
    let j = i + 1;
    while (j < formula.length && !(formula[j] === ch && formula[j + 1] !== ch)) j += formula[j] === ch ? 2 : 1;
    out += formula.slice(i, j + 1);
    i = j;
  }
  return out + fn(part);
}

/** A formula as Excel stores it: no `=`, newer functions with `_xlfn.`. */
export function toExcelFormula(formula: string): string {
  const body = formula.startsWith('=') ? formula.slice(1) : formula;
  return outsideQuotes(body, (part) =>
    part.replace(/(^|[^A-Za-z0-9_.])([A-Za-z][A-Za-z0-9.]*)(?=\s*\()/g, (all, before: string, name: string) =>
      FUTURE_FUNCTIONS.has(name.toUpperCase()) ? `${before}_xlfn.${name}` : all,
    ),
  );
}

/** A formula from Excel: `=` added, `_xlfn.` and `_xlws.` prefixes removed. */
export function fromExcelFormula(formula: string): string {
  return '=' + outsideQuotes(formula, (part) => part.replace(/_xl(?:fn|ws)\./gi, ''));
}

function cachedFrom(cell: XLSX.CellObject): CachedValue | undefined {
  switch (cell.t) {
    case 'n':
      return typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : undefined;
    case 's':
      return typeof cell.v === 'string' ? cell.v : undefined;
    case 'b':
      return typeof cell.v === 'boolean' ? cell.v : undefined;
    case 'e':
      return { e: cell.w ?? '#VALUE!' };
    default:
      return undefined;
  }
}

/** Whether `data` starts like a workbook: a zip (.xlsx, .ods) or an OLE file (.xls). */
function looksLikeWorkbook(data: Uint8Array): boolean {
  const zip = data[0] === 0x50 && data[1] === 0x4b;
  const ole = data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0;
  return zip || ole;
}

/** Reads an Excel (or OpenDocument) workbook; throws for anything else. */
export function readWorkbook(data: Uint8Array): ImportedBook {
  // SheetJS reads any text as a table; a file named .xlsx must be a workbook.
  if (!looksLikeWorkbook(data)) throw new Error('This is not an Excel or OpenDocument workbook.');
  const wb = XLSX.read(data, { type: 'array', cellFormula: true, cellNF: true, cellStyles: true, cellDates: false, dense: false });
  const skipped = new Set<string>();
  const sheets: ImportedSheet[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const sheet: ImportedSheet = { name: freeSheetName(sheetName, sheets), cells: {}, cols: {}, rows: {} };
    if (sheet.name !== sheetName) skipped.add(`The sheet “${sheetName}” is called “${sheet.name}”.`);
    for (const [key, raw] of Object.entries(ws)) {
      if (key.startsWith('!')) continue;
      const at = parseA1(key);
      const cell = raw as XLSX.CellObject;
      if (!at || at.col >= MAX_COLUMNS || at.row >= MAX_ROWS) continue;
      const out: SheetCell = {};
      if (typeof cell.f === 'string' && cell.f !== '') {
        out.f = fromExcelFormula(cell.f);
        const c = cachedFrom(cell);
        if (c !== undefined) out.c = c;
      } else if (cell.F) {
        // A value inside an array formula's range: the formula spills into it.
        const c = cachedFrom(cell);
        if (c !== undefined) out.c = c;
      } else if (cell.t === 'e') {
        // A literal error has no place in the format; it reads as text.
        out.v = cell.w ?? '#VALUE!';
      } else {
        const v = cachedFrom(cell);
        if (v !== undefined && !isCellError(v) && v !== null && v !== '') out.v = v;
      }
      if (cell.z !== undefined && typeof cell.z === 'string' && !isGeneral(cell.z) && (out.v !== undefined || out.f !== undefined || out.c !== undefined)) out.fmt = cell.z;
      if (out.v !== undefined || out.f !== undefined || out.c !== undefined) sheet.cells[key] = out;
    }
    ws['!cols']?.forEach((c, i) => {
      if (c?.wpx && i < MAX_COLUMNS) sheet.cols[columnLetters(i)] = { w: Math.round(c.wpx) };
    });
    ws['!rows']?.forEach((r, i) => {
      if (r?.hpx && i < MAX_ROWS) sheet.rows[String(i + 1)] = { h: Math.round(r.hpx) };
    });
    if (ws['!merges']?.length) skipped.add('Merged cells are shown unmerged.');
    sheets.push(sheet);
  }
  // Sheets whose names had to change keep their formulas (all renamed at once, so renames never chain).
  const renames = wb.SheetNames.flatMap((original, i): Array<[string, string]> => (sheets[i].name === original ? [] : [[original, sheets[i].name]]));
  if (renames.length > 0) for (const s of sheets) for (const c of Object.values(s.cells)) if (c.f !== undefined) c.f = renameSheetsInFormula(c.f, renames);
  const named: Record<string, string> = {};
  for (const n of wb.Workbook?.Names ?? []) {
    if (n.Sheet !== undefined) {
      skipped.add(`The name “${n.Name}” belongs to one sheet and was left out.`);
      continue;
    }
    if (n.Name.startsWith('_xlnm.') || /^_/.test(n.Name)) continue;
    const ref = n.Ref.startsWith('=') ? n.Ref.slice(1) : n.Ref;
    named[n.Name] = renameSheetsInFormula('=' + ref, renames).slice(1);
  }
  return { sheets, named, skipped: [...skipped] };
}

/** The cells an array formula at `ref` spills into, as a range (null when it spills nowhere). */
function spillRange(cells: Record<string, SheetCell>, ref: string): string | null {
  const at = parseA1(ref);
  if (!at) return null;
  const spilled = (col: number, row: number) => {
    const c = cells[toA1(col, row)];
    return c !== undefined && c.v === undefined && c.f === undefined && c.c !== undefined;
  };
  let lastRow = at.row;
  while (spilled(at.col, lastRow + 1)) lastRow++;
  let lastCol = at.col;
  while (spilled(lastCol + 1, at.row)) lastCol++;
  if (lastRow === at.row && lastCol === at.col) return null;
  return `${ref}:${toA1(lastCol, lastRow)}`;
}

function valueCell(value: CachedValue): XLSX.CellObject | null {
  if (value === null) return null;
  if (typeof value === 'number') return { t: 'n', v: value };
  if (typeof value === 'string') return { t: 's', v: value };
  if (typeof value === 'boolean') return { t: 'b', v: value };
  return { t: 'e', v: ERROR_CODES[value.e] ?? ERROR_CODES['#VALUE!'], w: value.e };
}

/**
 * Sheet names as Excel takes them (at most 31 characters, unique without regard to case), and a
 * function that points formulas at them.
 */
function excelNames(file: SheetFile): { names: string[]; follow(formula: string): string } {
  const names: string[] = [];
  const renamed: Array<[string, string]> = [];
  for (const sheet of file.sheets) {
    let name = sheet.name.slice(0, 31);
    for (let n = 2; names.some((x) => x.toLowerCase() === name.toLowerCase()); n++) name = `${sheet.name.slice(0, 31 - String(n).length - 3)} (${n})`;
    names.push(name);
    if (name !== sheet.name) renamed.push([sheet.name, name]);
  }
  return { names, follow: (f) => renameSheetsInFormula(f, renamed) };
}

/** The workbook as an .xlsx file. */
export function writeWorkbook(file: SheetFile): Uint8Array {
  const wb = XLSX.utils.book_new();
  const { names, follow } = excelNames(file);
  file.sheets.forEach((sheet, index) => {
    const ws: XLSX.WorkSheet = {};
    let maxCol = 0;
    let maxRow = 0;
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      const at = parseA1(ref);
      if (!at) continue;
      let out: XLSX.CellObject | null;
      if (cell.f !== undefined) {
        out = valueCell(cell.c ?? null) ?? { t: 'z' };
        out.f = toExcelFormula(follow(cell.f));
        const spill = spillRange(sheet.cells, ref);
        if (spill) {
          out.F = spill;
          out.D = true;
        }
      } else out = valueCell(cellValue(cell));
      if (!out) continue;
      const fmt = effectiveFormat(sheet, at.col, at.row);
      if (fmt !== undefined && !isGeneral(fmt)) out.z = fmt;
      ws[ref] = out;
      maxCol = Math.max(maxCol, at.col);
      maxRow = Math.max(maxRow, at.row);
    }
    ws['!ref'] = `A1:${toA1(maxCol, maxRow)}`;
    const cols = Object.entries(sheet.cols).filter(([, p]) => p.w !== undefined);
    if (cols.length > 0) {
      const list: XLSX.ColInfo[] = [];
      for (const [key, p] of cols) list[columnIndex(key)] = { wpx: p.w };
      ws['!cols'] = Array.from(list, (c) => c ?? {});
    }
    const rows = Object.entries(sheet.rows).filter(([, p]) => p.h !== undefined);
    if (rows.length > 0) {
      const list: XLSX.RowInfo[] = [];
      for (const [key, p] of rows) list[Number(key) - 1] = { hpx: p.h };
      ws['!rows'] = Array.from(list, (r) => r ?? {});
    }
    XLSX.utils.book_append_sheet(wb, ws, names[index]);
  });
  const defined = Object.entries(file.named).map(([Name, Ref]) => ({ Name, Ref: follow('=' + Ref).slice(1) }));
  if (defined.length > 0) wb.Workbook = { ...wb.Workbook, Names: defined };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}
