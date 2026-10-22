// Live Preview tables (DESIGN §6.6.1): what the grid shares with the note editor and with later
// roadmap items, kept apart so the grid and the extension that places it import it without cycles.
import { Annotation, Facet, StateEffect, type EditorState, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CellDisplay } from './render';
import type { Align } from './model';

/** A table's contents as the grid shows them (`rows[0]` is the header), for a cell formatter. */
export interface TableGridData {
  rows: readonly (readonly string[])[];
  align: readonly Align[];
  /** Where the table starts in the note (the start of its first line), in `state`. */
  from: number;
  /** The note's state the table is drawn for. */
  state: EditorState;
}

/**
 * Shows cells as something other than their Markdown: given a table, returns the display of each
 * cell, or null for a cell (or a whole table) it leaves alone. ROADMAP 39 plugs its formulas in
 * here: a cell whose text starts with `=` shows its result, and editing the cell shows the formula,
 * with the cell's name and result in the grid's formula bar. Formatters run when a table renders;
 * dispatch `refreshTables` when their results change, or call `redrawTableDisplays` (grid.ts) when
 * only the displays changed (an edit of another table changed a result).
 */
export type TableCellFormatter = (table: TableGridData) => ((row: number, column: number) => CellDisplay | null) | null;

export const tableCellFormatters = Facet.define<TableCellFormatter>();

/** Redraws every table: a cell formatter's results changed (its engine finished loading, say). */
export const refreshTables = StateEffect.define<null>();

/** The note editor's setup for a table cell's editor (language, Live Preview, completion, keys). */
export const tableCellSetup = Facet.define<() => Extension, (() => Extension) | null>({
  combine: (values) => values[0] ?? null,
});

/** In a table cell's editor: the note's editor the cell belongs to (its undo history, its links). */
export const tableCellHost = Facet.define<EditorView, EditorView | null>({
  combine: (values) => values[0] ?? null,
});

/** Marks the transactions a table grid makes in the note, with the grid's id. */
export const tableEdit = Annotation.define<number>();

/** How the note's editor shows its tables: locked (read-only), and whether images from the web load in cells. */
export interface TablesConfig {
  locked: boolean;
  remoteImages?: boolean;
}

export const tablesConfig = Facet.define<TablesConfig, TablesConfig>({
  combine: (values) => values[0] ?? { locked: false },
});

/** The editor that holds a view's undo history: the note's editor for a table cell's editor. */
export function historyEditor(view: EditorView): EditorView {
  return view.state.facet(tableCellHost) ?? view;
}

/** Whether `view` is a table cell's editor. */
export function isTableCell(view: EditorView): boolean {
  return view.state.facet(tableCellHost) !== null;
}

/** Where a table shows as a grid (grid.ts's TableBlock is one). */
export interface TableRange {
  from: number;
  to: number;
}

let rangesOf: (state: EditorState) => readonly TableRange[] = () => [];

/**
 * The note's tables that show as grids, for code outside the editor (a session's insertion point).
 * The tables extension (index.ts, in the editor's chunk) provides it when it loads; until then no
 * state has grids.
 */
export function tableRanges(state: EditorState): readonly TableRange[] {
  return rangesOf(state);
}

export function provideTableRanges(read: (state: EditorState) => readonly TableRange[]): void {
  rangesOf = read;
}
