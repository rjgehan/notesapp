// Live Preview tables (DESIGN §6.6.1): what the grid shares with the note editor and with later
// roadmap items, kept apart so the grid and the extension that places it import it without cycles.
import { Annotation, Facet, StateEffect, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CellDisplay } from './render';
import type { Align } from './model';

/** A table's contents as the grid shows them (`rows[0]` is the header), for a cell formatter. */
export interface TableGridData {
  rows: readonly (readonly string[])[];
  align: readonly Align[];
}

/**
 * Shows cells as something other than their Markdown: given a table, returns the display of each
 * cell, or null for a cell (or a whole table) it leaves alone. ROADMAP 39 plugs its formulas in
 * here: a cell whose text starts with `=` shows its result, and editing the cell shows the formula.
 * Formatters run when a table renders; dispatch `refreshTables` when their results change.
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

/** How the note's editor shows its tables. */
export const tablesConfig = Facet.define<{ locked: boolean }, { locked: boolean }>({
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
