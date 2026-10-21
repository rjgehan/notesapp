// The spreadsheet grid (DESIGN §6.21.5): Glide Data Grid over the active sheet, with A1 column
// letters, row numbers, frozen columns (Glide's own) and frozen rows (drawn in its sticky header
// below the letters), column resizing, the fill handle, and keys for undo, fill and bold rows.
// Clipboard events are the editor's (SheetEditor), so they work on frozen cells too.
import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawHeaderCallback,
  type GridCell,
  type CellClickedEventArgs,
  type GridKeyEventArgs,
  type GridSelection,
  type HeaderClickedEventArgs,
  type Item,
  type Rectangle,
} from '@glideapps/glide-data-grid';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { columnLetters } from '../../sheets/a1';
import { shownCell } from '../../sheets/display';
import type { Sheet } from '../../sheets/format';
import type { CellRange } from '../../sheets/refs';
import { isApple } from '../../features/platform';
import {
  frozenRowAt,
  frozenRowTop,
  fromGridSelection,
  gridCell,
  gridColumns,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  toGridSelection,
  type CellAt,
  type GridLayout,
  type SheetSelection,
} from './gridModel';
import type { SheetTheme } from './theme';

export interface SheetGridHandlers {
  onSelect(sel: SheetSelection): void;
  /** Editing in the formula bar (touch devices, frozen cells), optionally replacing the text with `initial`. */
  onEdit(at: CellAt, initial?: string): void;
  /** Glide's own cell editor committed `text`. */
  onCommit(at: CellAt, text: string): void;
  onClear(range: CellRange): void;
  onFill(source: CellRange, dest: CellRange): void;
  onUndo(): void;
  onRedo(): void;
  /** Escape in the grid (not in an editor): drops a pending cut. */
  onEscape(): void;
  onFillDown(): void;
  onFillRight(): void;
  onToggleBold(): void;
  onColumnWidth(col: number, width: number): void;
  /** A right-click on a cell or a header, at a point on the screen (the selection already covers it). */
  onContextMenu(x: number, y: number): void;
  /** The grid scrolled close to its last row or column. */
  onGrow(rows: number, cols: number): void;
}

interface Props {
  sheet: Sheet;
  layout: GridLayout;
  /** Changes with every workbook change, so the grid redraws. */
  version: number;
  selection: SheetSelection;
  /** A range to outline with dashes (a cut waiting to be pasted), or null. */
  marked: CellRange | null;
  editable: boolean;
  touch: boolean;
  theme: SheetTheme;
  handlers: SheetGridHandlers;
  gridRef: RefObject<DataEditorRef | null>;
  portalRef: RefObject<HTMLDivElement | null>;
}

const inRange = (col: number, row: number, r: CellRange) => col >= r.col && col < r.col + r.width && row >= r.row && row < r.row + r.height;

/**
 * Glide's keys. The clipboard, fills and clearing are the view's own. F2 opens the cell's editor, as in
 * Excel and Google Sheets; Glide would otherwise let it reach the app's "Rename file" hotkey.
 */
const KEYBINDINGS = { copy: false, cut: false, paste: false, downFill: false, rightFill: false, search: false, clear: false, activateCell: ' |Enter|shift+Enter|F2' };

const MOVES: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export function SheetGrid({ sheet, layout, version, selection, marked, editable, touch, theme, handlers, gridRef, portalRef }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  /** The last press began on the frozen rows: Glide must not turn it into a column selection. */
  const frozenPress = useRef(false);
  const lastFrozenClick = useRef<{ col: number; row: number; at: number } | null>(null);
  /**
   * When the user last pressed on the grid's rows or a key in it. Glide also selects on its own:
   * focusing it without a selection (a frozen cell is selected) picks the first visible cell.
   */
  const userInput = useRef(0);
  /** A tap's edit waits for its touchend (see requestEdit). */
  const pendingEdit = useRef<CellAt | null>(null);
  const lastPointer = useRef('mouse');
  const latestHandlers = useRef(handlers);
  useLayoutEffect(() => {
    latestHandlers.current = handlers;
  });

  // A tap edits in the formula bar. The focus moves there in the tap's touchend, which is a user
  // gesture on iOS (so the keyboard opens), and that touchend's default is prevented: otherwise
  // the emulated mousedown that follows a tap would take the focus away again.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onTouchEnd = (e: TouchEvent) => {
      const at = pendingEdit.current;
      if (!at) return;
      pendingEdit.current = null;
      e.preventDefault();
      latestHandlers.current.onEdit(at);
    };
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => el.removeEventListener('touchend', onTouchEnd);
  }, []);

  const requestEdit = useCallback(
    (at: CellAt) => {
      if (lastPointer.current !== 'touch') {
        handlers.onEdit(at);
        return;
      }
      pendingEdit.current = at;
      // A pointer that sends no touch events (a stylus on some devices) still gets its edit.
      setTimeout(() => {
        if (pendingEdit.current !== at) return;
        pendingEdit.current = null;
        latestHandlers.current.onEdit(at);
      }, 400);
    },
    [handlers],
  );
  /** Widths while a column is being dragged; the model gets the final one. */
  const [sizing, setSizing] = useState<ReadonlyMap<number, number>>(new Map());
  const f = layout.frozenRows;
  const frozenActive = selection.active.row < f;
  const band = layout.headerBand;
  const headerHeight = band + layout.frozenHeight;
  const fontFamily = theme.grid.fontFamily ?? 'system-ui, sans-serif';

  // The model is mutable: `version` changes with every change, and the callbacks below with it, so
  // the grid redraws.
  const model = useMemo(() => ({ sheet, version }), [sheet, version]);
  const columns = useMemo(() => gridColumns(model.sheet, layout, sizing, theme), [model, layout, sizing, theme]);
  const gridSelection = useMemo(() => toGridSelection(selection, layout), [selection, layout]);
  // The part of a marked range below the frozen rows (those are drawn in the header).
  const highlightRegions = useMemo(() => {
    if (!marked || marked.row + marked.height <= f) return undefined;
    const top = Math.max(marked.row, f);
    return [{ color: theme.grid.accentLight ?? 'rgba(138, 92, 245, 0.16)', style: 'dashed' as const, range: { x: marked.col, y: top - f, width: marked.width, height: marked.row + marked.height - top } }];
  }, [marked, f, theme]);

  const cellOptions = useMemo(() => ({ overlay: editable && !touch, readonly: !editable, colors: theme.colors }), [editable, touch, theme.colors]);
  const getCellContent = useCallback(([col, row]: Item): GridCell => gridCell(model.sheet, col, row + f, cellOptions), [model, f, cellOptions]);

  const rowHeight = useCallback((row: number) => layout.rowHeight(row + f), [layout, f]);
  const boldFont = `700 ${theme.fontSize}px`;
  const getRowThemeOverride = useCallback((row: number) => (model.sheet.rows[String(row + f + 1)]?.bold ? { baseFontStyle: boldFont } : undefined), [model, f, boldFont]);

  // ---------- frozen rows, drawn in the header ----------

  const drawHeader = useCallback<DrawHeaderCallback>(
    ({ ctx, columnIndex: col, rect, isSelected }) => {
      const g = theme.grid;
      ctx.save();
      ctx.textBaseline = 'middle';
      const bandTop = rect.y + band;
      if (col < 0) {
        // The corner, and the frozen rows' numbers.
        ctx.font = `${g.markerFontStyle ?? '12px'} ${fontFamily}`;
        ctx.textAlign = 'center';
        for (let r = 0; r < f; r++) {
          const y = bandTop + frozenRowTop(layout, r);
          const h = layout.rowHeight(r);
          if (selection.active.row === r) {
            ctx.fillStyle = g.bgHeaderHasFocus ?? '#363636';
            ctx.fillRect(rect.x, y, rect.width, h);
          }
          ctx.fillStyle = g.textHeader ?? '#a3a3a3';
          ctx.fillText(String(r + 1), rect.x + rect.width / 2, y + h / 2);
        }
        ctx.restore();
        return;
      }
      // Column letters, centred as in Google Sheets.
      if (frozenActive && selection.active.col === col && !isSelected) {
        ctx.fillStyle = g.bgHeaderHasFocus ?? '#363636';
        ctx.fillRect(rect.x, rect.y, rect.width, band);
      }
      ctx.font = `${g.headerFontStyle ?? '500 12px'} ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = isSelected ? (g.textHeaderSelected ?? '#fff') : (g.textHeader ?? '#a3a3a3');
      ctx.fillText(columnLetters(col), rect.x + rect.width / 2, rect.y + band / 2);
      const { sheet } = model;
      const columnBold = sheet.cols[columnLetters(col)]?.bold === true;
      for (let r = 0; r < f; r++) {
        const y = bandTop + frozenRowTop(layout, r);
        const h = layout.rowHeight(r);
        ctx.fillStyle = g.bgCell ?? '#1e1e1e';
        ctx.fillRect(rect.x, y, rect.width, h);
        const single = selection.range.width === 1 && selection.range.height === 1;
        if (!single && inRange(col, r, selection.range)) {
          ctx.fillStyle = g.accentLight ?? 'rgba(138, 92, 245, 0.16)';
          ctx.fillRect(rect.x, y, rect.width, h);
        }
        const { text, align, color } = shownCell(sheet, col, r);
        if (text !== '') {
          ctx.save();
          ctx.beginPath();
          ctx.rect(rect.x, y, rect.width, h);
          ctx.clip();
          const bold = columnBold || sheet.rows[String(r + 1)]?.bold === true;
          ctx.font = `${bold ? '700 ' : ''}${theme.fontSize}px ${fontFamily}`;
          ctx.fillStyle = color ? theme.colors[color] : (g.textDark ?? '#dadada');
          const pad = g.cellHorizontalPadding ?? 6;
          ctx.textAlign = align;
          const x = align === 'left' ? rect.x + pad : align === 'right' ? rect.x + rect.width - pad : rect.x + rect.width / 2;
          ctx.fillText(text, x, y + h / 2);
          ctx.restore();
        }
        // Grid lines: below each frozen row, and on the right of the column.
        ctx.fillStyle = g.borderColor ?? '#363636';
        ctx.fillRect(rect.x, y + h - 1, rect.width, 1);
        ctx.fillRect(rect.x + rect.width - 1, y, 1, h);
        if (selection.active.col === col && selection.active.row === r) {
          ctx.strokeStyle = g.accentColor ?? '#8a5cf5';
          ctx.lineWidth = 2;
          ctx.strokeRect(rect.x + 1, y + 1, rect.width - 2, h - 2);
        }
      }
      ctx.restore();
    },
    [theme, fontFamily, f, layout, selection, frozenActive, model, band],
  );

  // ---------- selection ----------

  const onGridSelectionChange = useCallback(
    (next: GridSelection) => {
      // A press on the frozen rows selects a cell there (onHeaderClicked), not the column.
      if (frozenPress.current && !next.current) return;
      // While a frozen cell is selected, only the user moves the selection into the grid.
      if (frozenActive && next.current && Date.now() - userInput.current > 1000) return;
      const sel = fromGridSelection(next, layout);
      if (sel) handlers.onSelect(sel);
    },
    [layout, handlers, frozenActive],
  );

  const onHeaderClicked = useCallback(
    (col: number, e: HeaderClickedEventArgs) => {
      if (col < 0 || e.localEventY < band) return;
      const row = frozenRowAt(layout, e.localEventY - band);
      if (row === null) return;
      e.preventDefault();
      const last = lastFrozenClick.current;
      const now = Date.now();
      const again = last !== null && last.col === col && last.row === row && now - last.at < 600;
      lastFrozenClick.current = { col, row, at: now };
      handlers.onSelect({ active: { col, row }, range: { col, row, width: 1, height: 1 } });
      if ((again || e.isDoubleClick === true || (e.isTouch && selection.active.col === col && selection.active.row === row)) && editable) requestEdit({ col, row });
    },
    [layout, handlers, selection, editable, requestEdit, band],
  );

  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      // Desktop cells open Glide's editor themselves; touch devices edit in the formula bar.
      if (editable && touch) requestEdit({ col, row: row + f });
    },
    [editable, touch, requestEdit, f],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, value: { kind: GridCellKind; data?: unknown }) => {
      if (value.kind === GridCellKind.Text && typeof value.data === 'string') handlers.onCommit({ col, row: row + f }, value.data);
    },
    [handlers, f],
  );

  const onDelete = useCallback(
    (sel: GridSelection) => {
      const s = fromGridSelection(sel, layout);
      if (s && editable) handlers.onClear(s.range);
      return false;
    },
    [layout, editable, handlers],
  );

  const onFillPattern = useCallback(
    (e: { patternSource: Rectangle; fillDestination: Rectangle; preventDefault(): void }) => {
      e.preventDefault();
      const toRange = (r: Rectangle): CellRange => ({ col: r.x, row: r.y + f, width: r.width, height: r.height });
      if (editable) handlers.onFill(toRange(e.patternSource), toRange(e.fillDestination));
    },
    [editable, handlers, f],
  );

  // ---------- context menu ----------

  // A right-click outside the selection selects what it is on first (a cell, a whole row from its
  // number, a whole column from its letter), as in Google Sheets; the menu then acts on the selection.
  const selectFor = useCallback(
    (col: number, row: number | null) => {
      const r = selection.range;
      if (col < 0 && row !== null) {
        const whole = r.col === 0 && r.width >= layout.cols && row >= r.row && row < r.row + r.height;
        if (!whole) handlers.onSelect({ active: { col: 0, row }, range: { col: 0, row, width: layout.cols, height: 1 } });
      } else if (row === null) {
        const whole = r.row === 0 && r.height >= layout.rows && col >= r.col && col < r.col + r.width;
        if (!whole) handlers.onSelect({ active: { col, row: 0 }, range: { col, row: 0, width: 1, height: layout.rows } });
      } else if (!inRange(col, row, r)) handlers.onSelect({ active: { col, row }, range: { col, row, width: 1, height: 1 } });
    },
    [handlers, selection, layout],
  );

  const onCellContextMenu = useCallback(
    ([col, row]: Item, e: CellClickedEventArgs) => {
      e.preventDefault();
      selectFor(col, row + f);
      handlers.onContextMenu(e.bounds.x + e.localEventX, e.bounds.y + e.localEventY);
    },
    [handlers, selectFor, f],
  );

  const onHeaderContextMenu = useCallback(
    (col: number, e: HeaderClickedEventArgs) => {
      e.preventDefault();
      if (col >= 0) selectFor(col, e.localEventY >= band ? frozenRowAt(layout, e.localEventY - band) : null);
      handlers.onContextMenu(e.bounds.x + e.localEventX, e.bounds.y + e.localEventY);
    },
    [handlers, selectFor, layout, band],
  );

  // ---------- keys ----------

  const onKeyDown = useCallback(
    (e: GridKeyEventArgs) => {
      const mod = isApple ? e.metaKey : e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const take = () => {
        e.cancel();
        e.preventDefault();
      };
      if (e.key === 'Escape') {
        handlers.onEscape();
        return;
      }
      if (mod && !e.altKey) {
        const command =
          key === 'z' && !e.shiftKey
            ? handlers.onUndo
            : (key === 'z' && e.shiftKey) || key === 'y'
              ? handlers.onRedo
              : !editable
                ? null
                : key === 'd'
                  ? handlers.onFillDown
                  : key === 'r'
                    ? handlers.onFillRight
                    : key === 'b'
                      ? handlers.onToggleBold
                      : null;
        if (command) {
          take();
          command();
        }
        return;
      }
      const { col, row } = selection.active;
      // Up from the first grid row moves into the frozen rows.
      if (!frozenActive && f > 0 && e.key === 'ArrowUp' && !e.shiftKey && row === f) {
        take();
        handlers.onSelect({ active: { col, row: f - 1 }, range: { col, row: f - 1, width: 1, height: 1 } });
        return;
      }
      // Frozen cells, and every cell on a touch device, are edited in the formula bar.
      if (!frozenActive && !touch) return;
      const move = MOVES[e.key];
      if (frozenActive && move) {
        take();
        const next = { col: Math.max(0, Math.min(layout.cols - 1, col + move[0])), row: Math.max(0, row + move[1]) };
        handlers.onSelect({ active: next, range: { ...next, width: 1, height: 1 } });
        return;
      }
      if (!editable || e.altKey) return;
      if (e.key === 'Enter' || e.key === 'F2') {
        take();
        handlers.onEdit({ col, row });
      } else if (frozenActive && (e.key === 'Delete' || e.key === 'Backspace')) {
        take();
        handlers.onClear({ col, row, width: 1, height: 1 });
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        take();
        handlers.onEdit({ col, row }, e.key);
      }
    },
    [handlers, editable, selection, frozenActive, f, touch, layout.cols],
  );

  // ---------- columns and size ----------

  const onColumnResize = useCallback((_c: unknown, size: number, col: number) => {
    setSizing((m) => new Map(m).set(col, size));
  }, []);

  const onColumnResizeEnd = useCallback(
    (_c: unknown, size: number, col: number) => {
      setSizing((m) => {
        const next = new Map(m);
        next.delete(col);
        return next;
      });
      if (editable) handlers.onColumnWidth(col, Math.round(size));
    },
    [editable, handlers],
  );

  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      const gridRows = layout.rows - f;
      const nearBottom = range.y + range.height > gridRows - 50;
      const nearRight = range.x + range.width > layout.cols - 3;
      if (nearBottom || nearRight) handlers.onGrow(nearBottom ? layout.rows + 500 : layout.rows, nearRight ? layout.cols + 10 : layout.cols);
    },
    [layout, f, handlers],
  );

  return (
    <div
      ref={wrapper}
      className="sheet-grid"
      onPointerDownCapture={(e) => {
        const box = wrapper.current?.getBoundingClientRect();
        const y = box ? e.clientY - box.top : -1;
        frozenPress.current = f > 0 && y >= band && y < headerHeight;
        lastPointer.current = e.pointerType;
        userInput.current = y >= headerHeight ? Date.now() : 0;
      }}
      onKeyDownCapture={() => {
        userInput.current = Date.now();
      }}
    >
      <DataEditor
        ref={gridRef}
        width="100%"
        height="100%"
        columns={columns}
        rows={layout.rows - f}
        getCellContent={getCellContent}
        rowHeight={rowHeight}
        headerHeight={headerHeight}
        rowMarkers={{ kind: 'clickable-number', startIndex: f + 1, headerDisabled: true }}
        freezeColumns={layout.frozenCols}
        getRowThemeOverride={getRowThemeOverride}
        drawHeader={drawHeader}
        theme={theme.grid}
        gridSelection={gridSelection}
        highlightRegions={highlightRegions}
        onGridSelectionChange={onGridSelectionChange}
        rangeSelect="rect"
        columnSelect="multi"
        rowSelect="multi"
        onHeaderClicked={onHeaderClicked}
        onCellContextMenu={onCellContextMenu}
        onHeaderContextMenu={onHeaderContextMenu}
        onCellActivated={onCellActivated}
        onCellEdited={onCellEdited}
        onDelete={onDelete}
        fillHandle={editable && !touch}
        allowedFillDirections="orthogonal"
        onFillPattern={onFillPattern}
        onKeyDown={onKeyDown}
        keybindings={KEYBINDINGS}
        onColumnResize={editable ? onColumnResize : undefined}
        onColumnResizeEnd={editable ? onColumnResizeEnd : undefined}
        minColumnWidth={MIN_COLUMN_WIDTH}
        maxColumnWidth={MAX_COLUMN_WIDTH}
        onVisibleRegionChanged={onVisibleRegionChanged}
        cellActivationBehavior={touch ? 'second-click' : 'double-click'}
        editOnType={editable && !touch}
        getCellsForSelection
        portalElementRef={portalRef as RefObject<HTMLElement>}
        smoothScrollX
        smoothScrollY
        overscrollX={40}
        overscrollY={40}
      />
    </div>
  );
}

