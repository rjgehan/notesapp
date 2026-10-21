// The spreadsheet editor (DESIGN §6.21.5): title and toolbar, formula bar, grid and sheet tabs over
// one Workbook. Every change goes through the workbook (one undo step per action), which marks the
// session dirty (useSheetDocument), so autosave, drafts, conflicts and history work as for notes.
import type { DataEditorRef } from '@glideapps/glide-data-grid';
import {
  ArrowDownToLine,
  ArrowRightToLine,
  BetweenHorizontalStart,
  Bold,
  ChartColumn,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Download,
  Hash,
  Import,
  MoveHorizontal,
  Redo2,
  Snowflake,
  Tag,
  Undo2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { SaveStatus } from '../../components/SaveStatus';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';
import { pickFiles } from '../../features/attachments';
import { toastError } from '../../features/errors';
import { wantsNoteFocus } from '../../features/focus';
import { folderOf } from '../../features/paths';
import { keyLabel } from '../../features/platform';
import { columnLetters, parseA1, toA1 } from '../../sheets/a1';
import { setActiveSheet, type SheetActions } from '../../sheets/activeSheet';
import { guessChartOptions } from '../../sheets/charts';
import type { Separator } from '../../sheets/csv';
import { effectiveFormat } from '../../sheets/display';
import { clearEdits, clipStillHolds, copyRange, fillDownEdits, fillEdits, fillRightEdits, pasteEdits, typedEdit, type SheetClip } from '../../sheets/edits';
import type { CellEdit, FormatEdit, Workbook } from '../../sheets/engine';
import { cellText, cellValue, isCellError, sameName, sheetById, sheetByName, sheetNameProblem, type ChartProps, type Sheet } from '../../sheets/format';
import { changeDecimals, isGeneral } from '../../sheets/numfmt';
import { absoluteRangeText, parseRangeText, rangeText, type CellRange } from '../../sheets/refs';
import { resolveTarget, usedRange } from '../../sheets/target';
import type { ImportedBook } from '../../sheets/xlsx';
import { confirmAction, promptText } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import type { SessionSnapshot } from '../../sync/DocumentSession';
import { InlineTitle } from '../markdown/InlineTitle';
import { ChartsPane } from './ChartsPane';
import { FormulaBar, type EditTarget, type FormulaBarHandle, type Move } from './FormulaBar';
import { cellSelection, clampSelection, gridLayout, HEADER_BAND, TOUCH_HEADER_BAND, type CellAt, type SheetSelection } from './gridModel';
import {
  addToWorkbook,
  baseName,
  bookToFile,
  createSheetFile,
  csvBook,
  exportCsv,
  exportXlsx,
  IMPORT_ACCEPT,
  importKind,
  readCsvFile,
  readWorkbookFile,
  type ImportKind,
} from './importExport';
import { ChartDialog, ColumnWidthDialog, ImportDialog, NamedRangesDialog, NumberFormatDialog, type ImportChoice } from './SheetDialogs';
import { useReferencePicking } from './referencePicking';
import { SheetGrid, type SheetGridHandlers } from './SheetGrid';
import { SheetTabs } from './SheetTabs';
import { useCoarsePointer, useSheetTheme } from './theme';

interface Props {
  path: string;
  snapshot: SessionSnapshot;
  workbook: Workbook;
  version: number;
}

/** Per file, while the page lives: the open sheet, each sheet's selection, and whether the charts pane is folded. */
const remembered = new Map<string, { sheetId: string; selections: ReadonlyMap<string, SheetSelection>; chartsOpen: boolean }>();

/** The last copy (or cut) made in any spreadsheet, so a paste in this app brings formulas, or moves the cut cells. */
let lastClip: SheetClip | null = null;

/** Rows at most that "Bold" changes in one go (a whole-column selection bolds columns instead). */
const BOLD_LIMIT = 5000;
/** Cells at most that a number format is set on one by one; whole columns or rows take a column or row format. */
const FORMAT_LIMIT = 10000;

type Dialog =
  | { kind: 'named' | 'width' | 'format' }
  | { kind: 'chart'; id: string | null; initial: ChartProps }
  | { kind: 'import'; file: File; type: ImportKind; separator: Separator; text?: string; book?: ImportedBook };

/** The route's `#Summary` or `#Budget!A1:C3`, decoded. */
function decodeHash(hash: string): string | null {
  if (!hash || hash === '#') return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function step(at: CellAt, move: Move): CellAt {
  switch (move) {
    case 'down':
      return { col: at.col, row: at.row + 1 };
    case 'up':
      return { col: at.col, row: Math.max(0, at.row - 1) };
    case 'right':
      return { col: at.col + 1, row: at.row };
    case 'left':
      return { col: Math.max(0, at.col - 1), row: at.row };
    default:
      return at;
  }
}

interface ToolProps {
  title: string;
  hotkey?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  children: ReactNode;
}

function ToolButton({ title, hotkey, disabled, pressed, onClick, children }: ToolProps) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={title}
      title={hotkey ? `${title} (${keyLabel(hotkey)})` : title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SheetEditor({ path, snapshot, workbook, version }: Props) {
  const touch = useCoarsePointer();
  const theme = useSheetTheme(touch);
  const phone = useBreakpoint() === 'phone';
  const [sheetId, setSheetId] = useState(() => remembered.get(path)?.sheetId ?? workbook.file.sheets[0].id);
  const [selections, setSelections] = useState<ReadonlyMap<string, SheetSelection>>(() => remembered.get(path)?.selections ?? new Map());
  const [growth, setGrowth] = useState<ReadonlyMap<string, { rows: number; cols: number }>>(new Map());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [freezeMenu, setFreezeMenu] = useState<{ x: number; y: number } | null>(null);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);
  const [linesMenu, setLinesMenu] = useState<{ x: number; y: number } | null>(null);
  /** The cut waiting to be pasted, shown with a dashed outline while it is still the last copy. */
  const [cutMark, setCutMark] = useState<SheetClip | null>(null);
  /** The range a formula being typed points at. */
  const [picked, setPicked] = useState<CellRange | null>(null);
  // On a phone the charts start folded, so the grid keeps its room.
  const [chartsOpen, setChartsOpen] = useState(() => remembered.get(path)?.chartsOpen ?? !phone);
  const location = useLocation();
  const [gridHeight, setGridHeight] = useState(600);
  const gridRef = useRef<DataEditorRef | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const gridBox = useRef<HTMLDivElement>(null);
  const bar = useRef<FormulaBarHandle>(null);
  const editable = snapshot.loaded && snapshot.status !== 'readonly' && snapshot.status !== 'loading' && !snapshot.lossy;

  // The workbook's model is mutable; `version` changes with each change.
  const model = useMemo(() => ({ file: workbook.file, version }), [workbook, version]);
  const sheet: Sheet = sheetById(model.file, sheetId) ?? model.file.sheets[0];
  const grown = growth.get(sheet.id);
  const layout = useMemo(
    () =>
      gridLayout(sheetById(model.file, sheetId) ?? model.file.sheets[0], {
        rowHeight: touch ? 32 : 24,
        headerBand: touch ? TOUCH_HEADER_BAND : HEADER_BAND,
        minRows: grown?.rows ?? 0,
        minCols: grown?.cols ?? 0,
        // Frozen rows take at most half the grid (a phone in landscape).
        maxFrozenHeight: gridHeight / 2,
      }),
    [model, sheetId, touch, grown, gridHeight],
  );
  const selection = clampSelection(selections.get(sheet.id) ?? cellSelection(0, 0), layout);
  const activeRef = toA1(selection.active.col, selection.active.row);
  const activeCell = sheet.cells[activeRef];
  const activeValue = cellValue(activeCell);
  const activeFormat = effectiveFormat(sheet, selection.active.col, selection.active.row);
  const single = selection.range.width === 1 && selection.range.height === 1;
  const wholeColumns = selection.range.row === 0 && selection.range.height >= layout.rows;
  const wholeRows = !wholeColumns && selection.range.col === 0 && selection.range.width >= layout.cols;

  // A click or drag on cells while a formula is typed inserts references into it.
  useReferencePicking({ gridBox, gridRef, portalRef, barInput: () => bar.current?.editingInput() ?? null, layout: () => layout, onPick: setPicked });

  useEffect(() => {
    remembered.set(path, { sheetId: sheet.id, selections, chartsOpen });
  }, [path, sheet.id, selections, chartsOpen]);

  useLayoutEffect(() => {
    const el = gridBox.current;
    if (!el) return;
    const measure = () => setGridHeight(el.clientHeight || 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---------- operations ----------
  // Plain functions: the model is mutable, so memoizing on it would go stale.

  const focusGrid = () => {
    if (!touch) gridRef.current?.focus();
  };

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      toast(errorText(e), { kind: 'error' });
    }
  };

  const select = (sel: SheetSelection, id = sheet.id) => setSelections((m) => new Map(m).set(id, sel));

  const setCells = (edits: CellEdit[], opts: { implyFormats?: boolean } = {}) => {
    if (edits.length > 0) run(() => workbook.setCells(edits, opts));
  };

  /** The text the formula bar edits for a cell: its formula, or its value as typed (dates as dates). */
  const editText = (s: Sheet, at: CellAt) => cellText(s.cells[toA1(at.col, at.row)], effectiveFormat(s, at.col, at.row));

  const edit = (at: CellAt, initial?: string) => {
    bar.current?.edit({ ...at, sheet: sheet.id }, editText(sheet, at), initial);
  };

  const commit = (target: EditTarget, text: string, move: Move) => {
    const s = sheetById(workbook.file, target.sheet);
    if (!s) return;
    // Typed input brings the format it implies (`10%`, `=TODAY()`) into a cell without one.
    if (text !== editText(s, target)) run(() => workbook.setCells([typedEdit(s, target.col, target.row, text)], { implyFormats: true }));
    if (move === 'none' || s.id !== sheet.id) return;
    const next = step(target, move);
    select(cellSelection(next.col, next.row));
    // On a phone the keyboard stays up for the next cell; elsewhere the grid takes the keys again.
    if (touch && editable) bar.current?.edit({ ...next, sheet: s.id }, editText(s, next));
    else focusGrid();
  };

  const undo = () => {
    workbook.undo();
  };
  const redo = () => {
    workbook.redo();
  };
  const fillDown = () => setCells(fillDownEdits(sheet, selection.range));
  const fillRight = () => setCells(fillRightEdits(sheet, selection.range));

  /** Bold rows; with whole columns selected, bold columns. */
  const toggleBold = () => {
    const r = selection.range;
    run(() =>
      workbook.transact(() => {
        if (wholeColumns) {
          const keys = Array.from({ length: Math.min(r.width, 1000) }, (_, i) => columnLetters(r.col + i));
          const all = keys.every((k) => sheet.cols[k]?.bold === true);
          for (const k of keys) {
            const props = { ...sheet.cols[k] };
            if (all) delete props.bold;
            else props.bold = true;
            workbook.setColumn(sheet.id, k, props);
          }
          return;
        }
        const keys = Array.from({ length: Math.min(r.height, BOLD_LIMIT) }, (_, i) => String(r.row + i + 1));
        const all = keys.every((k) => sheet.rows[k]?.bold === true);
        for (const k of keys) {
          const props = { ...sheet.rows[k] };
          if (all) delete props.bold;
          else props.bold = true;
          workbook.setRow(sheet.id, k, props);
        }
      }),
    );
  };

  const setFrozen = (rows: number, cols: number) => run(() => workbook.setFrozen(sheet.id, { rows, cols }));

  // ---------- inserting and deleting rows and columns ----------

  /** The selected rows (the active cell's row when whole columns are selected), and columns likewise. */
  const rowSpan = wholeColumns ? { at: selection.active.row, count: 1 } : { at: selection.range.row, count: selection.range.height };
  const colSpan = wholeRows ? { at: selection.active.col, count: 1 } : { at: selection.range.col, count: selection.range.width };
  const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const rowsLabel = rowSpan.count === 1 ? `row ${rowSpan.at + 1}` : `rows ${rowSpan.at + 1}–${rowSpan.at + rowSpan.count}`;
  const colsLabel = colSpan.count === 1 ? `column ${columnLetters(colSpan.at)}` : `columns ${columnLetters(colSpan.at)}–${columnLetters(colSpan.at + colSpan.count - 1)}`;
  const insertRows = (below: boolean) => run(() => workbook.insertRows(sheet.id, rowSpan.at + (below ? rowSpan.count : 0), rowSpan.count));
  const insertColumns = (right: boolean) => run(() => workbook.insertColumns(sheet.id, colSpan.at + (right ? colSpan.count : 0), colSpan.count));
  const deleteRows = () => run(() => workbook.deleteRows(sheet.id, rowSpan.at, rowSpan.count));
  const deleteColumns = () => run(() => workbook.deleteColumns(sheet.id, colSpan.at, colSpan.count));
  const lineItems: MenuEntry[] = [
    { id: 'rowsAbove', label: `Insert ${plural(rowSpan.count, 'row', 'rows')} above`, run: () => insertRows(false) },
    { id: 'rowsBelow', label: `Insert ${plural(rowSpan.count, 'row', 'rows')} below`, run: () => insertRows(true) },
    { id: 'colsLeft', label: `Insert ${plural(colSpan.count, 'column', 'columns')} left`, run: () => insertColumns(false) },
    { id: 'colsRight', label: `Insert ${plural(colSpan.count, 'column', 'columns')} right`, run: () => insertColumns(true) },
    'separator',
    { id: 'deleteRows', label: `Delete ${rowsLabel}`, danger: true, run: deleteRows },
    { id: 'deleteCols', label: `Delete ${colsLabel}`, danger: true, run: deleteColumns },
  ];

  const setWidths = (cols: number[], width: number | null) => {
    run(() =>
      workbook.transact(() => {
        for (const col of cols) {
          const key = columnLetters(col);
          const props = { ...sheet.cols[key] };
          if (width === null) delete props.w;
          else props.w = width;
          workbook.setColumn(sheet.id, key, props);
        }
      }),
    );
  };

  // ---------- number formats ----------

  /** The selection for messages: `B3`, `A1:C4`, `columns B–D`, `rows 2–5`. */
  const selectionLabel = (() => {
    const r = selection.range;
    if (wholeColumns) return r.width === 1 ? `column ${columnLetters(r.col)}` : `columns ${columnLetters(r.col)}–${columnLetters(r.col + r.width - 1)}`;
    if (wholeRows) return r.height === 1 ? `row ${r.row + 1}` : `rows ${r.row + 1}–${r.row + r.height}`;
    return single ? activeRef : rangeText(r);
  })();

  /**
   * Sets the number format of the selection (undefined: Automatic) as one undo step: whole columns
   * or rows get a column or row format (and their cells lose their own), other selections a format
   * per cell. Automatic on a cell whose row or column has a format stores `General`, which wins.
   */
  const applyFormat = (fmt: string | undefined) => {
    const r = selection.range;
    const inRange = (ref: string) => {
      const at = parseA1(ref);
      return at !== null && at.col >= r.col && at.col < r.col + r.width && at.row >= r.row && at.row < r.row + r.height;
    };
    run(() =>
      workbook.transact(() => {
        if (wholeColumns || wholeRows) {
          const keys = wholeColumns
            ? Array.from({ length: Math.min(r.width, 1000) }, (_, i) => columnLetters(r.col + i))
            : Array.from({ length: Math.min(r.height, BOLD_LIMIT) }, (_, i) => String(r.row + i + 1));
          for (const key of keys) {
            const props = { ...(wholeColumns ? sheet.cols[key] : sheet.rows[key]) };
            if (fmt === undefined) delete props.fmt;
            else props.fmt = fmt;
            if (wholeColumns) workbook.setColumn(sheet.id, key, props);
            else workbook.setRow(sheet.id, key, props);
          }
          const own: FormatEdit[] = Object.entries(sheet.cells)
            .filter(([ref, c]) => c.fmt !== undefined && inRange(ref))
            .map(([ref]) => ({ sheet: sheet.id, ref, fmt: null }));
          workbook.setFormats(own);
          return;
        }
        if (r.width * r.height > FORMAT_LIMIT) throw new Error(`Select whole columns or rows to format more than ${FORMAT_LIMIT.toLocaleString('en-US')} cells.`);
        const edits: FormatEdit[] = [];
        for (let row = r.row; row < r.row + r.height; row++) {
          for (let col = r.col; col < r.col + r.width; col++) {
            const ref = toA1(col, row);
            const inherited = sheet.rows[String(row + 1)]?.fmt ?? sheet.cols[columnLetters(col)]?.fmt;
            const next = fmt ?? (isGeneral(inherited) ? null : 'General');
            if ((sheet.cells[ref]?.fmt ?? null) !== next) edits.push({ sheet: sheet.id, ref, fmt: next });
          }
        }
        workbook.setFormats(edits);
      }),
    );
  };

  const changeSelectionDecimals = (delta: 1 | -1) => {
    const next = changeDecimals(activeFormat, delta, typeof activeValue === 'number' ? activeValue : null);
    if (next === null) toast('Dates, times and text have no decimal places to change.');
    else applyFormat(next);
  };

  // ---------- charts ----------

  const insertChart = () => {
    // A single cell charts the sheet's data; a selection charts itself.
    const range = single ? (usedRange(sheet) ?? selection.range) : selection.range;
    setDialog({ kind: 'chart', id: null, initial: { type: 'bar', range: rangeText(range), ...guessChartOptions(sheet, range) } });
  };

  const saveChart = (id: string | null, props: ChartProps) => {
    setDialog(null);
    run(() => {
      if (id === null) workbook.addChart(sheet.id, props);
      else workbook.setChart(sheet.id, id, props);
    });
    setChartsOpen(true);
  };

  const deleteChart = async (id: string) => {
    const chart = sheet.charts[id];
    if (!chart) return;
    const ok = await confirmAction({
      title: `Delete the chart${chart.title ? ` “${chart.title}”` : ''}?`,
      message: 'Undo brings it back.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) run(() => workbook.setChart(sheet.id, id, null));
  };

  // ---------- import and export ----------

  const startImport = async () => {
    const [file] = await pickFiles({ accept: IMPORT_ACCEPT, multiple: false });
    if (!file) return;
    const type = importKind(file.name);
    if (!type) {
      toast('Choose a CSV, TSV or Excel file to import.', { kind: 'error' });
      return;
    }
    try {
      if (type === 'csv') {
        const { text, separator } = await readCsvFile(file);
        setDialog({ kind: 'import', file, type, separator, text });
      } else setDialog({ kind: 'import', file, type, separator: ',', book: await readWorkbookFile(file) });
    } catch (e) {
      toastError(e, `Could not read ${file.name}`);
    }
  };

  const finishImport = async (d: Extract<Dialog, { kind: 'import' }>, choice: ImportChoice) => {
    setDialog(null);
    const book = d.type === 'csv' ? csvBook(d.file.name, d.text ?? '', choice.separator, choice.convert) : d.book;
    if (!book) return;
    const report = (skipped: string[]) =>
      toast([`Imported “${d.file.name}”.`, ...skipped.slice(0, 3)].join(' '), { timeout: skipped.length > 0 ? 10000 : 4000 });
    if (choice.target === 'sheet') {
      try {
        const { sheetId: id, skipped } = addToWorkbook(workbook, book);
        if (id) setSheetId(id);
        report(skipped);
      } catch (e) {
        toast(errorText(e), { kind: 'error' });
      }
      return;
    }
    try {
      await createSheetFile(folderOf(path), baseName(d.file.name), bookToFile(book));
      report(book.skipped);
    } catch (e) {
      toastError(e, `Could not import ${d.file.name}`);
    }
  };

  const exportItems: MenuEntry[] = [
    { id: 'csv', label: `Download “${sheet.name}” as CSV`, run: () => exportCsv(path, workbook.file, sheet) },
    {
      id: 'xlsx',
      label: 'Download as Excel (.xlsx)',
      run: () => void exportXlsx(path, workbook.file).catch((e: unknown) => toastError(e, 'Could not export the workbook')),
    },
  ];

  const addSheet = () => run(() => setSheetId(workbook.addSheet()));

  const renameSheet = async (id: string) => {
    const current = sheetById(workbook.file, id);
    if (!current) return;
    const name = await promptText({
      title: 'Rename sheet',
      label: 'Name',
      value: current.name,
      confirmLabel: 'Rename',
      validate: (v) => (v === current.name ? null : sheetNameProblem(v, workbook.file, id)),
    });
    if (name !== null && name !== current.name) run(() => workbook.renameSheet(id, name));
  };

  const deleteSheet = async (id: string) => {
    const target = sheetById(workbook.file, id);
    if (!target || workbook.file.sheets.length <= 1) return;
    const ok = await confirmAction({
      title: `Delete sheet “${target.name}”?`,
      message: 'Formulas that refer to it will show #REF!. Undo brings it back.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const index = workbook.file.sheets.findIndex((s) => s.id === id);
    run(() => workbook.removeSheet(id));
    const sheets = workbook.file.sheets;
    if (!sheetById(workbook.file, id) && id === sheet.id) setSheetId(sheets[Math.min(index, sheets.length - 1)].id);
  };

  /** The name box: a cell, a range (on another sheet too) or a named range. */
  const goTo = (text: string): boolean => {
    const file = workbook.file;
    const name = Object.keys(file.named).find((n) => sameName(n, text.trim()));
    const target = parseRangeText(name !== undefined ? file.named[name] : text);
    if (!target) return false;
    const dest = target.sheet !== null ? sheetByName(file, target.sheet) : sheet;
    if (!dest) return false;
    showRange(dest, target.range);
    // The grid scrolls to the new selection itself.
    focusGrid();
    return true;
  };

  /** Opens sheet `dest` with `r` selected. */
  const showRange = (dest: Sheet, r: CellRange) => {
    setSheetId(dest.id);
    select({ active: { col: r.col, row: r.row }, range: r }, dest.id);
    // The selection may lie beyond the rows the grid has shown so far.
    setGrowth((m) => {
      const g = m.get(dest.id);
      return new Map(m).set(dest.id, { rows: Math.max(g?.rows ?? 0, r.row + r.height + 100), cols: Math.max(g?.cols ?? 0, r.col + r.width + 4) });
    });
  };

  // A link or embed that opened `Budget.sheet#Summary` or `#Budget!A1:C3` (DESIGN §6.21.7).
  const hashTarget = decodeHash(location.hash);
  const followHash = useRef<(text: string) => void>(() => {});
  useLayoutEffect(() => {
    followHash.current = (text) => {
      const t = resolveTarget(workbook.file, text);
      if (!t) return;
      if (t.range) showRange(t.sheet, t.range);
      else setSheetId(t.sheet.id);
    };
  });
  useEffect(() => {
    if (hashTarget !== null) followHash.current(hashTarget);
  }, [hashTarget, path]);

  // ---------- the clipboard (frozen cells included, so not Glide's) ----------

  const latest = useRef({ path, workbook, sheet, selection, editable, setCells, select });
  useLayoutEffect(() => {
    latest.current = { path, workbook, sheet, selection, editable, setCells, select };
  });

  useEffect(() => {
    const focused = () => !!gridBox.current?.contains(document.activeElement) && !bar.current?.isEditing();
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (!focused() || !e.clipboardData) return;
      const { path: source, sheet: s, selection: sel, editable: canEdit } = latest.current;
      const clip = copyRange(s, sel.range);
      e.clipboardData.setData('text/plain', clip.text);
      e.preventDefault();
      // A cut moves the cells when it is pasted in this spreadsheet, as in Google Sheets and Excel;
      // until then they stay, marked (pasted elsewhere, the cut is a copy).
      lastClip = cut && canEdit ? { ...clip, cut: { source, sheet: s.id } } : clip;
      setCutMark(lastClip.cut ? lastClip : null);
    };
    const onCopy = (e: ClipboardEvent) => copy(e, false);
    const onCut = (e: ClipboardEvent) => copy(e, true);
    const onPaste = (e: ClipboardEvent) => {
      if (!focused() || !e.clipboardData) return;
      const { path: here, workbook: wb, sheet: s, selection: sel, editable: canEdit, setCells: apply, select: choose } = latest.current;
      e.preventDefault();
      if (!canEdit) return;
      const text = e.clipboardData.getData('text/plain');
      const clip = lastClip;
      if (clip?.cut && clip.text === text) {
        setCutMark(null);
        const from = clip.cut.source === here ? sheetById(wb.file, clip.cut.sheet) : undefined;
        if (from && clipStillHolds(from, clip)) {
          const range: CellRange = { ...clip.range, col: sel.range.col, row: sel.range.row };
          try {
            wb.moveCells({ sheet: from.id, range: clip.range }, { sheet: s.id, col: range.col, row: range.row });
          } catch (err) {
            toast(errorText(err), { kind: 'error' });
            return;
          }
          // Pasting again copies the moved cells from their new place.
          const moved = sheetById(wb.file, s.id);
          lastClip = moved ? { ...copyRange(moved, range), text: clip.text } : null;
          choose({ active: { col: range.col, row: range.row }, range });
          return;
        }
        // The cut cells changed meanwhile (or are in another spreadsheet): an ordinary paste.
        lastClip = { ...clip, cut: undefined };
      }
      const { edits, range } = pasteEdits(s, sel.range, text, lastClip);
      // Text from elsewhere is typed input: its formulas imply formats as typed ones do.
      apply(edits, { implyFormats: lastClip?.text !== text });
      choose({ active: { col: range.col, row: range.row }, range });
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  // ---------- palette commands, focus ----------

  const actions = useRef<Omit<SheetActions, 'path'> | null>(null);
  useLayoutEffect(() => {
    actions.current = {
      editable: () => editable,
      undo,
      redo,
      fillDown,
      fillRight,
      toggleBoldRows: toggleBold,
      freezeRows: () => setFrozen(selection.active.row + 1, sheet.frozen.cols),
      freezeColumns: () => setFrozen(sheet.frozen.rows, selection.active.col + 1),
      unfreeze: () => setFrozen(0, 0),
      addSheet,
      insertRowsAbove: () => insertRows(false),
      insertRowsBelow: () => insertRows(true),
      insertColumnsLeft: () => insertColumns(false),
      insertColumnsRight: () => insertColumns(true),
      deleteRows,
      deleteColumns,
      openNamedRanges: () => setDialog({ kind: 'named' }),
      openColumnWidth: () => setDialog({ kind: 'width' }),
      openNumberFormat: () => setDialog({ kind: 'format' }),
      increaseDecimals: () => changeSelectionDecimals(1),
      decreaseDecimals: () => changeSelectionDecimals(-1),
      insertChart,
      importFile: () => void startImport(),
      exportCsv: () => exportCsv(path, workbook.file, sheet),
      exportXlsx: () => void exportXlsx(path, workbook.file).catch((e: unknown) => toastError(e, 'Could not export the workbook')),
    };
  });
  useEffect(() => {
    const call = (name: Exclude<keyof SheetActions, 'path' | 'editable'>) => () => actions.current?.[name]();
    return setActiveSheet({
      path,
      editable: () => actions.current?.editable() ?? false,
      undo: call('undo'),
      redo: call('redo'),
      fillDown: call('fillDown'),
      fillRight: call('fillRight'),
      toggleBoldRows: call('toggleBoldRows'),
      freezeRows: call('freezeRows'),
      freezeColumns: call('freezeColumns'),
      unfreeze: call('unfreeze'),
      addSheet: call('addSheet'),
      insertRowsAbove: call('insertRowsAbove'),
      insertRowsBelow: call('insertRowsBelow'),
      insertColumnsLeft: call('insertColumnsLeft'),
      insertColumnsRight: call('insertColumnsRight'),
      deleteRows: call('deleteRows'),
      deleteColumns: call('deleteColumns'),
      openNamedRanges: call('openNamedRanges'),
      openColumnWidth: call('openColumnWidth'),
      openNumberFormat: call('openNumberFormat'),
      increaseDecimals: call('increaseDecimals'),
      decreaseDecimals: call('decreaseDecimals'),
      insertChart: call('insertChart'),
      importFile: call('importFile'),
      exportCsv: call('exportCsv'),
      exportXlsx: call('exportXlsx'),
    });
  }, [path]);

  // A keyboard navigation (or Enter in a new spreadsheet's title) lands in the grid.
  useEffect(() => {
    if (wantsNoteFocus()) gridRef.current?.focus();
  }, [path]);

  const handlers: SheetGridHandlers = {
    onSelect: (sel) => select(sel),
    onEdit: edit,
    onCommit: (at, text) => commit({ ...at, sheet: sheet.id }, text, 'none'),
    onClear: (range) => setCells(clearEdits(sheet, range)),
    onFill: (source, dest) => setCells(fillEdits(sheet, source, dest)),
    onUndo: undo,
    onRedo: redo,
    onEscape: () => {
      // Escape drops a pending cut: a later paste copies.
      if (lastClip?.cut) lastClip = { ...lastClip, cut: undefined };
      setCutMark(null);
    },
    onFillDown: fillDown,
    onFillRight: fillRight,
    onToggleBold: toggleBold,
    onColumnWidth: (col, width) => setWidths([col], width),
    onContextMenu: (x, y) => {
      if (editable) setLinesMenu({ x, y });
    },
    onGrow: (rows, cols) =>
      setGrowth((m) => {
        const g = m.get(sheet.id);
        if (g && g.rows >= rows && g.cols >= cols) return m;
        return new Map(m).set(sheet.id, { rows: Math.max(g?.rows ?? 0, rows), cols: Math.max(g?.cols ?? 0, cols) });
      }),
  };

  // ---------- render ----------

  const widthColumns: number[] = Array.from({ length: Math.min(selection.range.width, 200) }, (_, i) => selection.range.col + i);
  const widthLabel = widthColumns.length === 1 ? columnLetters(widthColumns[0]) : `${columnLetters(widthColumns[0])}–${columnLetters(widthColumns[widthColumns.length - 1])}`;
  const boldOn = wholeColumns ? sheet.cols[columnLetters(selection.range.col)]?.bold === true : sheet.rows[String(selection.range.row + 1)]?.bold === true;
  const freezeItems: MenuEntry[] = [
    { id: 'rows', label: `Freeze rows 1–${selection.active.row + 1}`, run: () => setFrozen(selection.active.row + 1, sheet.frozen.cols) },
    { id: 'cols', label: `Freeze columns A–${columnLetters(selection.active.col)}`, run: () => setFrozen(sheet.frozen.rows, selection.active.col + 1) },
    'separator',
    { id: 'unrows', label: 'Unfreeze rows', disabled: sheet.frozen.rows === 0, run: () => setFrozen(0, sheet.frozen.cols) },
    { id: 'uncols', label: 'Unfreeze columns', disabled: sheet.frozen.cols === 0, run: () => setFrozen(sheet.frozen.rows, 0) },
  ];
  /** A toolbar action, after which the grid takes the keys again. */
  const tool = (action: 'undo' | 'redo' | 'bold' | 'down' | 'right') => {
    ({ undo, redo, bold: toggleBold, down: fillDown, right: fillRight })[action]();
    focusGrid();
  };

  return (
    <div className="sheet-view">
      <header className="sheet-header">
        <InlineTitle key={path} path={path} editable={editable} label="Spreadsheet title" onEnter={() => gridRef.current?.focus()} />
        {!phone && <SaveStatus snapshot={snapshot} />}
      </header>
      <div className="sheet-toolbar" role="toolbar" aria-label="Spreadsheet">
        <ToolButton title="Undo" hotkey="Mod-z" disabled={!editable || !workbook.canUndo()} onClick={() => tool('undo')}>
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton title="Redo" hotkey="Mod-Shift-z" disabled={!editable || !workbook.canRedo()} onClick={() => tool('redo')}>
          <Redo2 size={16} />
        </ToolButton>
        <span className="sheet-toolbar-sep" aria-hidden />
        <ToolButton title={wholeColumns ? 'Bold columns' : 'Bold rows'} hotkey="Mod-b" disabled={!editable} pressed={boldOn} onClick={() => tool('bold')}>
          <Bold size={16} />
        </ToolButton>
        <ToolButton title="Fill down" hotkey="Mod-d" disabled={!editable} onClick={() => tool('down')}>
          <ArrowDownToLine size={16} />
        </ToolButton>
        <ToolButton title="Fill right" hotkey="Mod-r" disabled={!editable} onClick={() => tool('right')}>
          <ArrowRightToLine size={16} />
        </ToolButton>
        <span className="sheet-toolbar-sep" aria-hidden />
        <ToolButton
          title="Freeze rows or columns"
          disabled={!editable}
          pressed={sheet.frozen.rows > 0 || sheet.frozen.cols > 0}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFreezeMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <Snowflake size={16} />
        </ToolButton>
        <ToolButton title="Column width" disabled={!editable} onClick={() => setDialog({ kind: 'width' })}>
          <MoveHorizontal size={16} />
        </ToolButton>
        <ToolButton
          title="Insert or delete rows and columns"
          disabled={!editable}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setLinesMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <BetweenHorizontalStart size={16} />
        </ToolButton>
        <span className="sheet-toolbar-sep" aria-hidden />
        <ToolButton title="Decrease decimal places" disabled={!editable} onClick={() => changeSelectionDecimals(-1)}>
          <DecimalsArrowLeft size={16} />
        </ToolButton>
        <ToolButton title="Increase decimal places" disabled={!editable} onClick={() => changeSelectionDecimals(1)}>
          <DecimalsArrowRight size={16} />
        </ToolButton>
        <ToolButton title="Number format" disabled={!editable} pressed={!isGeneral(activeFormat)} onClick={() => setDialog({ kind: 'format' })}>
          <Hash size={16} />
        </ToolButton>
        <span className="sheet-toolbar-sep" aria-hidden />
        <ToolButton title="Insert chart" disabled={!editable} onClick={insertChart}>
          <ChartColumn size={16} />
        </ToolButton>
        <ToolButton title="Named ranges" onClick={() => setDialog({ kind: 'named' })}>
          <Tag size={16} />
        </ToolButton>
        <span className="sheet-toolbar-sep" aria-hidden />
        <ToolButton title="Import CSV or Excel" disabled={!snapshot.loaded} onClick={() => void startImport()}>
          <Import size={16} />
        </ToolButton>
        <ToolButton
          title="Download as CSV or Excel"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setExportMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <Download size={16} />
        </ToolButton>
      </div>
      <FormulaBar
        ref={bar}
        label={single ? activeRef : rangeText(selection.range)}
        active={selection.active}
        sheet={sheet.id}
        text={cellText(activeCell, activeFormat)}
        editable={editable}
        touch={touch}
        error={isCellError(activeValue) ? workbook.errorMessage(sheet.id, activeRef) : null}
        onCommit={commit}
        onCancel={focusGrid}
        onGoTo={goTo}
      />
      <div ref={gridBox} className="sheet-grid-box">
        <SheetGrid
          sheet={sheet}
          layout={layout}
          version={version}
          selection={selection}
          editable={editable}
          touch={touch}
          theme={theme}
          handlers={handlers}
          picked={picked}
          marked={cutMark !== null && cutMark === lastClip && cutMark.cut?.sheet === sheet.id && cutMark.cut.source === path ? cutMark.range : null}
          gridRef={gridRef}
          portalRef={portalRef}
        />
      </div>
      <ChartsPane
        sheet={sheet}
        editable={editable}
        open={chartsOpen}
        onToggle={() => setChartsOpen((o) => !o)}
        onEdit={(id) => setDialog({ kind: 'chart', id, initial: sheet.charts[id] })}
        onDelete={(id) => void deleteChart(id)}
      />
      <SheetTabs
        sheets={model.file.sheets}
        activeId={sheet.id}
        editable={editable}
        onSelect={setSheetId}
        onAdd={addSheet}
        onRename={(id) => void renameSheet(id)}
        onDelete={(id) => void deleteSheet(id)}
        onMove={(id, index) => run(() => workbook.moveSheet(id, index))}
      />
      <div ref={portalRef} className="sheet-portal" />
      {freezeMenu && <ContextMenu x={freezeMenu.x} y={freezeMenu.y} label="Freeze" items={freezeItems} onClose={() => setFreezeMenu(null)} />}
      {exportMenu && <ContextMenu x={exportMenu.x} y={exportMenu.y} label="Download" items={exportItems} onClose={() => setExportMenu(null)} />}
      {linesMenu && <ContextMenu x={linesMenu.x} y={linesMenu.y} label="Rows and columns" items={lineItems} onClose={() => setLinesMenu(null)} />}
      {dialog?.kind === 'named' && (
        <NamedRangesDialog
          workbook={workbook}
          editable={editable}
          selectionRef={absoluteRangeText(sheet.name, selection.range)}
          onGoTo={(name) => {
            setDialog(null);
            goTo(name);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'width' && (
        <ColumnWidthDialog
          label={widthLabel}
          width={layout.columnWidth(selection.active.col)}
          onApply={(width) => {
            setDialog(null);
            setWidths(widthColumns, width);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'format' && (
        <NumberFormatDialog
          current={activeFormat}
          value={activeValue}
          target={selectionLabel}
          onApply={(fmt) => {
            setDialog(null);
            applyFormat(fmt);
            focusGrid();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'chart' && (
        <ChartDialog sheet={sheet} initial={dialog.initial} editing={dialog.id !== null} onSave={(props) => saveChart(dialog.id, props)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'import' && (
        <ImportDialog
          fileName={dialog.file.name}
          kind={dialog.type}
          separator={dialog.separator}
          sheetCount={dialog.book?.sheets.length}
          canAddSheets={editable}
          onImport={(choice) => void finishImport(dialog, choice)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
