// Live Preview tables (DESIGN §6.6.1, ROADMAP 10a): every top-level GFM table shows as an editable
// grid (grid.ts), a block widget over the table's lines, computed from the Lezer tree. Source mode
// shows the raw table; locked mode shows the grid read-only; tables inside quotes and lists stay
// text. Around a grid, the note's caret follows a few rules, so that typing next to a table never
// makes the text part of it (a line right under a table is one of its rows in GFM).
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Prec, RangeSet, RangeValue, StateField, Transaction, type ChangeDesc, type Extension, type SelectionRange } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, type Command, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { toast } from '../../../state/toasts';
import { noteContext, vaultChanged } from '../../context';
import { textReplace } from '../../remote';
import { provideTableRanges, refreshTables, tableCellHost, tableEdit, tablesConfig, type TablesConfig } from './facets';
import { gridAt, gridsOf, TableWidget, type TableBlock } from './grid';
import { newTableText, parseTable, rowCount, type TableModel } from './model';
import { parsedPast, topLevel, wholeLines } from '../topLevel';

export { historyEditor, isTableCell, refreshTables, tableCellFormatters, tableCellSetup, type TableCellFormatter, type TableGridData } from './facets';
export type { TableBlock } from './grid';
export { redrawTableDisplays } from './grid';
export { cellLanguage, type CellDisplay } from './render';

interface Tables {
  blocks: readonly TableBlock[];
  decorations: DecorationSet;
  atomic: RangeSet<RangeValue>;
  revision: number;
  editable: boolean;
}

class Atom extends RangeValue {}
const atom = new Atom();

/** A table's lines, and its node in the tree (a table the parse found), to know it again after an edit. */
interface FoundTable extends TableBlock {
  node?: { from: number; to: number };
}

function findTables(state: EditorState, previous: Tables | null, changes: ChangeDesc | null, revision: number): Tables {
  const editable = !state.facet(tablesConfig).locked && !state.readOnly;
  // A table the edit did not touch keeps its text and model, at its new place (ROADMAP 10c: a
  // keystroke in a long note slices no table's text and reads no table's lines again).
  const kept = new Map<number, FoundTable>();
  for (const b of (previous?.blocks ?? []) as readonly FoundTable[]) {
    if (!b.node || (changes && !changes.empty && changes.touchesRange(b.from, b.to))) continue;
    if (!changes || changes.empty) {
      kept.set(b.node.from, b);
      continue;
    }
    const node = { from: changes.mapPos(b.node.from), to: changes.mapPos(b.node.to) };
    kept.set(node.from, { ...b, from: changes.mapPos(b.from), to: changes.mapPos(b.to), node });
  }
  let known: Map<string, TableModel> | null = null;
  let reused = 0;
  const blocks: FoundTable[] = [];
  const add = (from: number, to: number, node?: { from: number; to: number }) => {
    const text = state.sliceDoc(from, to);
    known ??= new Map(previous?.blocks.map((b) => [b.text, b.model]));
    const model = known.get(text) ?? parseTable(text);
    if (model) blocks.push({ from, to, text, model, node });
  };
  // Only the note's own blocks: tables inside quotes, lists and callouts stay text.
  const top = topLevel(state);
  for (const t of top.tables) {
    const same = kept.get(t.from);
    if (same && same.node!.to === t.to) {
      blocks.push(same);
      reused++;
      continue;
    }
    const lines = wholeLines(state, t);
    if (lines) add(lines.from, lines.to, { from: t.from, to: t.to });
  }
  // Where the parse has not caught up with an edit yet, a table keeps its place, mapped through
  // the edit, while its text still reads as a table: an edit never makes a grid blink out (and
  // close the cell being edited). The parse decides again once it gets there.
  if (previous && changes) {
    for (const b of previous.blocks) {
      const from = changes.mapPos(b.from, 1);
      const to = changes.mapPos(b.to, -1);
      if (from < top.lastFrom || to <= from || parsedPast(state, to) || blocks.some((t) => t.from <= to && t.to >= from)) continue;
      if (state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to) add(from, to);
    }
    blocks.sort((a, b) => a.from - b.from);
  }
  // No table changed: the decorations map through the edit, with no new widgets.
  if (previous && changes && reused === blocks.length && blocks.length === previous.blocks.length && revision === previous.revision && editable === previous.editable) {
    return { blocks, decorations: previous.decorations.map(changes), atomic: previous.atomic.map(changes), revision, editable };
  }
  return {
    blocks,
    decorations: Decoration.set(blocks.map((b) => Decoration.replace({ widget: new TableWidget(b, editable, revision), block: true }).range(b.from, b.to))),
    atomic: RangeSet.of(blocks.map((b) => atom.range(b.from, b.to))),
    revision,
    editable,
  };
}

const tablesField = StateField.define<Tables>({
  create: (state) => findTables(state, null, null, 0),
  update(value, tr) {
    // A mode switch reconfigures the note's state and keeps this field's value: locking a note must
    // make its grids read-only (and unlocking editable), so a new configuration redraws them too.
    const refresh = tr.effects.some((e) => e.is(refreshTables) || e.is(vaultChanged)) || tr.startState.facet(tablesConfig) !== tr.state.facet(tablesConfig) || tr.startState.readOnly !== tr.state.readOnly;
    if (!refresh && !tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) return value;
    return findTables(tr.state, value, tr.changes, value.revision + (refresh ? 1 : 0));
  },
  provide: (field) => [EditorView.decorations.from(field, (t) => t.decorations), EditorView.atomicRanges.of((view) => view.state.field(field).atomic)],
});

/** The note's tables that show as grids. */
export function tableBlocks(state: EditorState): readonly TableBlock[] {
  return state.field(tablesField, false)?.blocks ?? [];
}

provideTableRanges(tableBlocks);

/** Whether `pos` is inside a table's text, where the note's caret never rests. */
function insideTable(state: EditorState, pos: number): boolean {
  return tableBlocks(state).some((t) => pos > t.from && pos < t.to);
}

/**
 * Keeps the grids' edited cells in place through the note's changes. When the note's text takes
 * the focus back, the open cell closes, and the note's caret (which rests on the edited cell, so
 * undo comes back to the table) moves out of the table's text.
 */
const tableEditing = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      const grids = gridsOf(update.view);
      for (const grid of grids) grid.beforeUpdate(update);
      if (!update.focusChanged || !update.view.hasFocus) return;
      for (const grid of grids) grid.deactivate();
      const view = update.view;
      if (insideTable(view.state, view.state.selection.main.head)) {
        // Not during the update; a click's own selection may already have moved it.
        queueMicrotask(() => {
          const head = view.state.selection.main.head;
          if (view.hasFocus && insideTable(view.state, head)) view.dispatch({ selection: EditorSelection.cursor(head), userEvent: 'select' });
        });
      }
    }
  },
);

// ---------- the note's caret around tables ----------

/**
 * The caret never rests inside a table's text: a move that lands there goes to the line before or
 * after the table, the way it was heading. When the table ends (or starts) the note, a move of
 * yours past it gets an empty line there: a caret against the table itself cannot be typed at.
 */
const settleAroundTables = EditorState.transactionFilter.of((tr) => {
  const selection = tr.selection;
  if (tr.docChanged || !selection || tr.annotation(tableEdit) !== undefined) return tr;
  const blocks = tableBlocks(tr.startState);
  if (blocks.length === 0) return tr;
  const length = tr.startState.doc.length;
  const old = tr.startState.selection.main.head;
  const pointer = tr.isUserEvent('select.pointer');
  let changed = false;
  const wanted: { line: { at: number; caret: number } | null } = { line: null };
  const ranges = selection.ranges.map((r, i): SelectionRange => {
    const b = r.empty ? blocks.find((t) => r.head >= t.from && r.head <= t.to) : undefined;
    if (!b) return r;
    const before = b.from > 0 ? b.from - 1 : null;
    const after = b.to < length ? b.to + 1 : null;
    const nearest = r.head - b.from <= b.to - r.head ? 'before' : 'after';
    const side = pointer ? nearest : old < b.from ? 'after' : old > b.to ? 'before' : nearest;
    const pos = side === 'after' ? after : before;
    if (pos !== null) {
      changed = true;
      return EditorSelection.cursor(pos);
    }
    if (tr.isUserEvent('select') && i === selection.mainIndex) {
      wanted.line = side === 'after' ? { at: b.to, caret: b.to + 1 } : { at: b.from, caret: b.from };
      return r;
    }
    const other = side === 'after' ? before : after;
    if (other === null) return r;
    changed = true;
    return EditorSelection.cursor(other);
  });
  if (wanted.line) {
    const { at, caret } = wanted.line;
    return { changes: { from: at, insert: '\n' }, selection: EditorSelection.cursor(caret), annotations: [tableEdit.of(0), Transaction.userEvent.of('input')], scrollIntoView: true };
  }
  return changed ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }] : tr;
});

/**
 * Text typed against a table goes on a line of its own, never into the table: at its end it gets a
 * blank line first (a line right under a table is one of its rows), and at its start a line break
 * after it.
 */
const guardTableEdges = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input') || tr.annotation(tableEdit) !== undefined || tr.annotation(textReplace)) return tr;
  const blocks = tableBlocks(tr.startState);
  if (blocks.length === 0) return tr;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
  if (changes.length !== 1) return tr;
  const [{ from, to, insert }] = changes;
  if (from !== to || insert.trim() === '') return tr;
  let before = '';
  let after = '';
  for (const b of blocks) {
    if (from === b.to) before = insert.startsWith('\n\n') ? '' : insert.startsWith('\n') ? '\n' : '\n\n';
    else if (from === b.from) after = insert.endsWith('\n') ? '' : '\n';
  }
  if (!before && !after) return tr;
  return {
    changes: { from, insert: before + insert + after },
    selection: EditorSelection.cursor(from + before.length + insert.length),
    annotations: Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? 'input'),
    scrollIntoView: true,
  };
});

const rowParser = markdownLanguage.parser;

/** Whether a line right under a table would be one of its rows (in GFM, a line that starts no other block). */
function joinsTable(line: string): boolean {
  if (line.trim() === '') return false;
  const text = ['|a|', '|-|', line].join('\n');
  const table = rowParser.parse(text).topNode.firstChild;
  return table !== null && table.name === 'Table' && table.to === text.length;
}

/**
 * An edit next to a table never makes the line under it one of its rows: typing on the empty line
 * under a table, deleting the blank line between it and a paragraph, or turning the heading under
 * it into text gets a line break that keeps the text apart. Edits of the table's own text, and
 * undo and redo, are left as they are.
 */
const keepTablesApart = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete')) || tr.annotation(tableEdit) !== undefined || tr.annotation(textReplace)) return tr;
  const blocks = tableBlocks(tr.startState);
  if (blocks.length === 0) return tr;
  const { doc } = tr.startState;
  const breaks: number[] = [];
  for (const b of blocks) {
    // The table and the line under it, before the edit.
    const below = b.to < doc.length ? doc.lineAt(b.to + 1).to : b.to;
    let touches = false;
    let inside = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= below && toA >= b.to) touches = true;
      if (fromA < b.to && toA > b.from) inside = true;
    });
    if (!touches || inside) continue;
    const end = tr.changes.mapPos(b.to, -1);
    if (end < tr.newDoc.length && joinsTable(tr.newDoc.lineAt(end + 1).text)) breaks.push(end);
  }
  return breaks.length ? [tr, { changes: breaks.map((at) => ({ from: at, insert: '\n' })), sequential: true }] : tr;
});

function caret(view: EditorView): number | null {
  const { selection } = view.state;
  if (view.state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return null;
  return selection.main.head;
}

/** Opens a cell of the table: the first one (`start`) or the last one (`end`), or `column` of its first or last row. */
function enterTable(view: EditorView, b: TableBlock, at: 'start' | 'end', column?: number): boolean {
  const grid = gridAt(view, b.from);
  if (!grid) return false;
  const row = at === 'start' ? 0 : rowCount(b.model) - 1;
  return grid.activate(row, column ?? (at === 'start' ? 0 : b.model.columns - 1), at);
}

/** ArrowDown and ArrowUp into a table open the cell under the caret. */
function vertically(forward: boolean): Command {
  return (view) => {
    const pos = caret(view);
    if (pos === null) return false;
    const target = view.moveVertically(view.state.selection.main, forward).head;
    const b = tableBlocks(view.state).find((t) => (forward ? t.from > pos && target >= t.from : t.to < pos && target <= t.to));
    if (!b) return false;
    const x = view.coordsAtPos(pos)?.left;
    const column = x === undefined ? 0 : (gridAt(view, b.from)?.columnAt(x) ?? 0);
    return enterTable(view, b, forward ? 'start' : 'end', column);
  };
}

/** ArrowRight at the end of the line before a table, and ArrowLeft at the start of the line after it, enter it. */
function horizontally(forward: boolean): Command {
  return (view) => {
    const pos = caret(view);
    if (pos === null) return false;
    const b = tableBlocks(view.state).find((t) => (forward ? pos === t.from - 1 : pos === t.to + 1));
    return b ? enterTable(view, b, forward ? 'start' : 'end') : false;
  };
}

/**
 * Backspace at the start of the line after a table, and Delete at the end of the line before it,
 * go into the table instead of joining the line to it (which would turn the line into a row or the
 * table into text). Only an empty last line, or an empty line not separating a paragraph from the
 * table, is deleted as usual. Right against the table (a caret after a table that ends the note),
 * a deletion would take the whole table, which is atomic; it goes into the table too.
 */
export function deleteNextToTable(forward: boolean): Command {
  return (view) => {
    const pos = caret(view);
    if (pos === null) return false;
    const { doc } = view.state;
    const blocks = tableBlocks(view.state);
    // A caret inside the table's text (it never rests there) deletes nothing of it.
    const inside = blocks.find((t) => pos > t.from && pos < t.to);
    if (inside) return enterTable(view, inside, forward ? 'start' : 'end');
    const b = blocks.find((t) => (forward ? pos === t.from - 1 || pos === t.from : pos === t.to + 1 || pos === t.to));
    if (!b) return false;
    if (pos === b.from || pos === b.to) return enterTable(view, b, forward ? 'start' : 'end');
    const line = doc.lineAt(pos);
    if (!forward && line.length === 0 && line.number === doc.lines) return false;
    if (forward && line.length === 0 && (line.number === 1 || doc.line(line.number - 1).text.trim() === '')) return false;
    return enterTable(view, b, forward ? 'start' : 'end');
  };
}

const tableKeymap = keymap.of([
  { key: 'ArrowDown', run: vertically(true) },
  { key: 'ArrowUp', run: vertically(false) },
  { key: 'ArrowRight', run: horizontally(true) },
  { key: 'ArrowLeft', run: horizontally(false) },
  ...['Backspace', 'Shift-Backspace', 'Mod-Backspace', 'Alt-Backspace'].map((key) => ({ key, run: deleteNextToTable(false) })),
  ...['Delete', 'Mod-Delete', 'Alt-Delete'].map((key) => ({ key, run: deleteNextToTable(true) })),
]);

/**
 * Inserts an empty table on the caret's line when it is blank, or after it, with the blank lines
 * that keep it apart from the text around it. In Live Preview its first header cell opens.
 */
export const insertTable: Command = (view) => {
  const { state } = view;
  if (state.readOnly || !state.facet(noteContext)) return false;
  if (state.facet(tableCellHost)) {
    toast('A table can’t go inside a table cell');
    return true;
  }
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = line.text.trim() === '';
  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const before = blank ? (previous && previous.text.trim() !== '' ? '\n' : '') : '\n\n';
  const after = next && next.text.trim() !== '' ? '\n' : '';
  const from = blank ? line.from : line.to;
  const start = from + before.length;
  view.dispatch({
    changes: { from, to: line.to, insert: before + newTableText() + after },
    // In source mode the caret goes into the first header cell.
    selection: EditorSelection.cursor(start + 2),
    annotations: [tableEdit.of(0), Transaction.userEvent.of('input.table')],
    scrollIntoView: true,
  });
  gridAt(view, start)?.activate(0, 0, 'start');
  return true;
};

/** Moves a table cell's editor to the next or previous cell (the phone toolbar's Next and Previous). */
export function moveToCell(view: EditorView, delta: 1 | -1): boolean {
  const host = view.state.facet(tableCellHost);
  const grid = host ? gridsOf(host).find((g) => g.activeCell()?.editor === view) : undefined;
  return grid ? grid.step(delta) : false;
}

/** The tables of Live Preview (DESIGN §6.6.1): grids, and in an editable note the caret rules around them. */
export function tables(config: TablesConfig): Extension {
  return [tablesConfig.of(config), tablesField, tableEditing, config.locked ? [] : [settleAroundTables, guardTableEdges, keepTablesApart, Prec.highest(tableKeymap)]];
}
