// The spreadsheet editor (DESIGN §6.21.5): title and toolbar, formula bar, grid and sheet tabs over
// one Workbook. Every change goes through the workbook (one undo step per action), which marks the
// session dirty (useSheetDocument), so autosave, drafts, conflicts and history work as for notes.
import type { DataEditorRef } from '@glideapps/glide-data-grid';
import { ArrowDownToLine, ArrowRightToLine, Bold, MoveHorizontal, Redo2, Snowflake, Tag, Undo2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { SaveStatus } from '../../components/SaveStatus';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';
import { wantsNoteFocus } from '../../features/focus';
import { keyLabel } from '../../features/platform';
import { columnLetters, toA1 } from '../../sheets/a1';
import { setActiveSheet, type SheetActions } from '../../sheets/activeSheet';
import { clearEdits, copyRange, fillDownEdits, fillEdits, fillRightEdits, pasteEdits, type SheetClip } from '../../sheets/edits';
import type { CellEdit, Workbook } from '../../sheets/engine';
import { cellInput, cellText, cellValue, isCellError, sameName, sheetById, sheetByName, sheetNameProblem, type Sheet } from '../../sheets/format';
import { absoluteRangeText, parseRangeText, rangeText } from '../../sheets/refs';
import { confirmAction, promptText } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import type { SessionSnapshot } from '../../sync/DocumentSession';
import { InlineTitle } from '../markdown/InlineTitle';
import { FormulaBar, type EditTarget, type FormulaBarHandle, type Move } from './FormulaBar';
import { cellSelection, clampSelection, gridLayout, HEADER_BAND, TOUCH_HEADER_BAND, type CellAt, type SheetSelection } from './gridModel';
import { ColumnWidthDialog, NamedRangesDialog } from './SheetDialogs';
import { SheetGrid, type SheetGridHandlers } from './SheetGrid';
import { SheetTabs } from './SheetTabs';
import { useCoarsePointer, useSheetTheme } from './theme';

interface Props {
  path: string;
  snapshot: SessionSnapshot;
  workbook: Workbook;
  version: number;
}

/** Per file, while the page lives: the open sheet and each sheet's selection. */
const remembered = new Map<string, { sheetId: string; selections: ReadonlyMap<string, SheetSelection> }>();

/** The last copy made in any spreadsheet, so a paste in this app brings formulas. */
let lastClip: SheetClip | null = null;

/** Rows at most that "Bold" changes in one go (a whole-column selection bolds columns instead). */
const BOLD_LIMIT = 5000;

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
  const [dialog, setDialog] = useState<'named' | 'width' | null>(null);
  const [freezeMenu, setFreezeMenu] = useState<{ x: number; y: number } | null>(null);
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
  const single = selection.range.width === 1 && selection.range.height === 1;
  const wholeColumns = selection.range.row === 0 && selection.range.height >= layout.rows;

  useEffect(() => {
    remembered.set(path, { sheetId: sheet.id, selections });
  }, [path, sheet.id, selections]);

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

  const setCells = (edits: CellEdit[]) => {
    if (edits.length > 0) run(() => workbook.setCells(edits));
  };

  const edit = (at: CellAt, initial?: string) => {
    bar.current?.edit({ ...at, sheet: sheet.id }, cellText(sheet.cells[toA1(at.col, at.row)]), initial);
  };

  const commit = (target: EditTarget, text: string, move: Move) => {
    const s = sheetById(workbook.file, target.sheet);
    if (!s) return;
    const ref = toA1(target.col, target.row);
    if (text !== cellText(s.cells[ref])) run(() => workbook.setCell(s.id, ref, cellInput(text)));
    if (move === 'none' || s.id !== sheet.id) return;
    const next = step(target, move);
    select(cellSelection(next.col, next.row));
    // On a phone the keyboard stays up for the next cell; elsewhere the grid takes the keys again.
    if (touch && editable) bar.current?.edit({ ...next, sheet: s.id }, cellText(s.cells[toA1(next.col, next.row)]));
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
    const r = target.range;
    setSheetId(dest.id);
    select({ active: { col: r.col, row: r.row }, range: r }, dest.id);
    // The selection may lie beyond the rows the grid has shown so far.
    setGrowth((m) => {
      const g = m.get(dest.id);
      return new Map(m).set(dest.id, { rows: Math.max(g?.rows ?? 0, r.row + r.height + 100), cols: Math.max(g?.cols ?? 0, r.col + r.width + 4) });
    });
    // The grid scrolls to the new selection itself.
    focusGrid();
    return true;
  };

  // ---------- the clipboard (frozen cells included, so not Glide's) ----------

  const latest = useRef({ sheet, selection, editable, setCells, select });
  useLayoutEffect(() => {
    latest.current = { sheet, selection, editable, setCells, select };
  });

  useEffect(() => {
    const focused = () => !!gridBox.current?.contains(document.activeElement) && !bar.current?.isEditing();
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (!focused() || !e.clipboardData) return;
      const { sheet: s, selection: sel, editable: canEdit, setCells: apply } = latest.current;
      const clip = copyRange(s, sel.range);
      e.clipboardData.setData('text/plain', clip.text);
      e.preventDefault();
      lastClip = clip;
      if (cut && canEdit) apply(clearEdits(s, sel.range));
    };
    const onCopy = (e: ClipboardEvent) => copy(e, false);
    const onCut = (e: ClipboardEvent) => copy(e, true);
    const onPaste = (e: ClipboardEvent) => {
      if (!focused() || !e.clipboardData) return;
      const { sheet: s, selection: sel, editable: canEdit, setCells: apply, select: choose } = latest.current;
      e.preventDefault();
      if (!canEdit) return;
      const { edits, range } = pasteEdits(s, sel.range, e.clipboardData.getData('text/plain'), lastClip);
      apply(edits);
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
      openNamedRanges: () => setDialog('named'),
      openColumnWidth: () => setDialog('width'),
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
      openNamedRanges: call('openNamedRanges'),
      openColumnWidth: call('openColumnWidth'),
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
    onFillDown: fillDown,
    onFillRight: fillRight,
    onToggleBold: toggleBold,
    onColumnWidth: (col, width) => setWidths([col], width),
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
        <InlineTitle key={path} path={path} editable={editable} label="Spreadsheet title" />
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
        <ToolButton title="Column width" disabled={!editable} onClick={() => setDialog('width')}>
          <MoveHorizontal size={16} />
        </ToolButton>
        <ToolButton title="Named ranges" onClick={() => setDialog('named')}>
          <Tag size={16} />
        </ToolButton>
      </div>
      <FormulaBar
        ref={bar}
        label={single ? activeRef : rangeText(selection.range)}
        active={selection.active}
        sheet={sheet.id}
        text={cellText(activeCell)}
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
          gridRef={gridRef}
          portalRef={portalRef}
        />
      </div>
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
      {dialog === 'named' && (
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
      {dialog === 'width' && (
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
    </div>
  );
}
