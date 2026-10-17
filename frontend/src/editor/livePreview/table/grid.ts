// Live Preview tables (DESIGN §6.6.1, ROADMAP 10a): the grid a table shows as. A block widget over
// the table's lines: cells show their Markdown rendered, and a click or tap edits a cell in place,
// in a small editor of its own. Every edit goes through the table model and writes the table's
// text back as one transaction of the note (one undo step); nothing outside the table changes.
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { diff } from '@codemirror/merge';
import { ensureSyntaxTree } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import { EditorSelection, EditorState, MapMode, Prec, Transaction, type ChangeSpec, type Extension } from '@codemirror/state';
import { EditorView, keymap, WidgetType, type Rect, type ViewUpdate } from '@codemirror/view';
import { resolve } from '../../../features/links';
import { modKey } from '../../../features/platform';
import { toast } from '../../../state/toasts';
import { activeEditor, setActiveEditor } from '../../activeEditor';
import { noteContext, type EditorMenuEntry } from '../../context';
import { followLink } from '../../editorCommands';
import { linkAt } from '../../linkAt';
import { addNestedEditor, removeNestedEditor } from '../../remote';
import { tableCellFormatters, tableCellHost, tableCellSetup, tableEdit } from './facets';
import {
  cellContent,
  cellSpans,
  deleteColumn,
  deleteRow,
  displayWidth,
  escapeCell,
  gridRows,
  insertColumn,
  insertRow,
  isSerializationOf,
  moveColumn,
  moveRow,
  rowCount,
  serializeTable,
  setAlign,
  setCell,
  unescapeCell,
  type Align,
  type CellPad,
  type TableModel,
} from './model';
import { cellLanguage, renderCell, renderDisplay, type CellDisplay, type CellRenderContext } from './render';

/** A table in the note: its lines (`from` is the start of its first line) and their model. */
export interface TableBlock {
  from: number;
  to: number;
  text: string;
  model: TableModel;
}

/** Where the caret goes in a cell that opens for editing. */
export type Place = 'start' | 'end' | 'all' | { x: number; y: number };

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
const DRAG_THRESHOLD = 4;

/** Spreadsheet-style column names (A, B, … Z, AA), as formulas will name them (ROADMAP 39). */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function cellLabel(row: number, column: number): string {
  return row === 0 ? `Header, column ${columnName(column)}` : `Row ${row}, column ${columnName(column)}`;
}

/** Text the way the table writes it: what a cell holds once its spacing and escapes are settled. */
function canonical(content: string): string {
  return unescapeCell(escapeCell(content.replace(/\r?\n/g, ' '))).replace(/^[ \t]+|[ \t]+$/g, '');
}

/** The minimal changes turning `a` into `b`, offset by `at`. */
function changesBetween(a: string, b: string, at: number): ChangeSpec[] {
  return diff(a, b).map((c) => ({ from: at + c.fromA, to: at + c.toA, insert: b.slice(c.fromB, c.toB) }));
}

/** Where an index ends up when the item at `from` moves to `to`. */
function movedIndex(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < index && index <= to) return index - 1;
  if (to <= index && index < from) return index + 1;
  return index;
}

/** The newline-free single line a cell holds: pasted line breaks become spaces. */
const singleLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let multiline = false;
  tr.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
    if (inserted.lines > 1) multiline = true;
  });
  if (!multiline) return tr;
  const changes: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.sliceString(0).replace(/\n/g, ' ') }));
  // A line break and a space have the same length, so the selection stays as it was.
  return { changes, selection: tr.selection, scrollIntoView: tr.scrollIntoView, annotations: Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? 'input') };
});

const byDom = new WeakMap<HTMLElement, TableGrid>();
const byView = new WeakMap<EditorView, Set<TableGrid>>();
let nextId = 1;

/** The grids of a note's editor. */
export function gridsOf(view: EditorView): readonly TableGrid[] {
  return [...(byView.get(view) ?? [])];
}

/** The grid of the table starting at `from`, if it is drawn. */
export function gridAt(view: EditorView, from: number): TableGrid | null {
  return gridsOf(view).find((g) => g.from() === from) ?? null;
}

/** The grid drawn for a widget element (tests). */
export function gridOf(dom: Element | null): TableGrid | null {
  return dom instanceof HTMLElement ? (byDom.get(dom) ?? null) : null;
}

export class TableWidget extends WidgetType {
  readonly block: TableBlock;
  readonly editable: boolean;
  readonly revision: number;
  constructor(block: TableBlock, editable: boolean, revision: number) {
    super();
    this.block = block;
    this.editable = editable;
    this.revision = revision;
  }
  override eq(other: TableWidget): boolean {
    return other.block.text === this.block.text && other.editable === this.editable && other.revision === this.revision;
  }
  toDOM(view: EditorView): HTMLElement {
    return new TableGrid(view, this).dom;
  }
  override updateDOM(dom: HTMLElement): boolean {
    const grid = byDom.get(dom);
    if (!grid) return false;
    grid.update(this);
    return true;
  }
  override destroy(dom: HTMLElement): void {
    byDom.get(dom)?.destroy();
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override get estimatedHeight(): number {
    return (this.block.model.body.length + 1) * 37 + 16;
  }
  override coordsAt(dom: HTMLElement, pos: number, side: number): Rect | null {
    return byDom.get(dom)?.coordsAt(pos, side) ?? null;
  }
}

interface ActiveCell {
  row: number;
  column: number;
  editor: EditorView;
  /** The cell between its pipes in the note, kept current through other changes to find it again. */
  span: { from: number; to: number } | null;
  /** A compact table's spacing of the cell when its editing began, kept while you type. */
  pad?: CellPad;
}

interface Drag {
  kind: 'row' | 'column';
  index: number;
  x: number;
  y: number;
  moved: boolean;
  target: number;
  grip: HTMLElement;
}

export class TableGrid {
  readonly dom: HTMLElement;
  readonly id = nextId++;
  readonly view: EditorView;
  private widget: TableWidget;
  private readonly scroller: HTMLElement;
  private readonly indicator: HTMLElement;
  private cells: HTMLTableCellElement[][] = [];
  /** What each cell shows, so an update redraws only the cells that changed. */
  private shown: string[][] = [];
  private shownEditable = false;
  private shownRevision = -1;
  private active: ActiveCell | null = null;
  /** The pending update's document changes: this grid's own, or another's (remote, undo). */
  private pending: 'own' | 'other' | null = null;
  private drag: Drag | null = null;
  private longPress: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private suppressClick = false;
  private lastPointer = 'mouse';
  private hoverColumn = -1;

  constructor(view: EditorView, widget: TableWidget) {
    this.view = view;
    this.widget = widget;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-lp-table';
    // Not part of the note's editable text: a cell's own editor is then an editing host of its own.
    this.dom.contentEditable = 'false';
    this.scroller = document.createElement('div');
    this.scroller.className = 'cm-lp-table-scroll';
    this.indicator = document.createElement('div');
    this.indicator.className = 'cm-lp-table-drop';
    this.indicator.hidden = true;
    this.dom.append(this.scroller, this.indicator);
    byDom.set(this.dom, this);
    let set = byView.get(view);
    if (!set) byView.set(view, (set = new Set()));
    set.add(this);
    this.dom.addEventListener('mousedown', this.onMouseDown);
    this.dom.addEventListener('click', this.onClick);
    this.dom.addEventListener('contextmenu', this.onContextMenu);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerCancel);
    this.dom.addEventListener('pointerover', this.onPointerOver);
    this.dom.addEventListener('pointerleave', this.onPointerLeave);
    this.dom.addEventListener('dragover', this.onDragOver);
    this.dom.addEventListener('drop', this.onDrop);
    this.render();
  }

  // ---------- state ----------

  /** Where the table starts in the note now, or null when the grid is not in the editor. */
  from(): number | null {
    if (!this.dom.isConnected) return null;
    try {
      return this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
  }

  model(): TableModel {
    return this.widget.block.model;
  }

  editable(): boolean {
    return this.widget.editable && !this.view.state.readOnly;
  }

  /** The cell being edited, as row and column, or null. */
  activeCell(): { row: number; column: number; editor: EditorView } | null {
    return this.active ? { row: this.active.row, column: this.active.column, editor: this.active.editor } : null;
  }

  private absoluteSpan(row: number, column: number, from = this.from()): { from: number; to: number } | null {
    if (from === null) return null;
    const span = cellSpans(this.model()).find((s) => s.row === row && s.column === column);
    return span ? { from: from + span.from, to: from + span.to } : null;
  }

  // ---------- updates from the note ----------

  /** Before the editor redraws: keeps the edited cell's place in the note through other changes. */
  beforeUpdate(update: ViewUpdate): void {
    this.pending = null;
    if (!update.docChanged) return;
    const own = update.transactions.every((tr) => !tr.docChanged || tr.annotation(tableEdit) === this.id);
    this.pending = own ? 'own' : 'other';
    const a = this.active;
    if (!own && a?.span) {
      const from = update.changes.mapPos(a.span.from, 1, MapMode.TrackDel);
      const to = update.changes.mapPos(a.span.to, -1, MapMode.TrackDel);
      a.span = from === null || to === null ? null : { from: Math.min(from, to), to: Math.max(from, to) };
    }
  }

  /** The table's text changed (or its editability, or the formatters' results). */
  update(widget: TableWidget): void {
    this.widget = widget;
    const pending = this.pending;
    this.pending = null;
    if (this.active && !this.editable()) this.deactivate();
    if (this.active && pending) this.relocate(pending);
    this.render();
  }

  /** Finds the edited cell again after the table changed; another's change to it shows in its editor. */
  private relocate(pending: 'own' | 'other'): void {
    const a = this.active!;
    const m = this.model();
    const from = this.widget.block.from;
    if (pending === 'own') {
      if (a.row >= rowCount(m) || a.column >= m.columns) return this.deactivate();
      a.span = this.absoluteSpan(a.row, a.column, from);
      return;
    }
    if (!a.span) return this.deactivate();
    const at = { from: a.span.from - from, to: a.span.to - from };
    const spans = cellSpans(m).filter((s) => s.column < m.columns);
    const containing = (pos: number) => spans.find((s) => s.from <= pos && pos <= s.to);
    // A minimal diff may put text inserted before the cell (a new row) just inside its start, so
    // the cell's end is the surer guide; when its two ends disagree, its content decides.
    let hit = spans.find((s) => s.from <= at.from && at.to <= s.to);
    if (!hit) {
      const byEnd = containing(at.to);
      const byStart = containing(at.from);
      const mine = canonical(a.editor.state.doc.toString());
      const same = (s: typeof byEnd) => s !== undefined && canonical(cellContent(m, s.row, s.column)) === mine;
      hit = same(byEnd) ? byEnd : same(byStart) ? byStart : (byEnd ?? byStart);
    }
    if (!hit) return this.deactivate();
    if (hit.row !== a.row || hit.column !== a.column) this.moveEditorTo(hit.row, hit.column);
    a.span = { from: from + hit.from, to: from + hit.to };
    this.syncActive(cellContent(m, a.row, a.column));
  }

  /** Puts another's change to the edited cell into its editor, as a minimal change (the caret stays). */
  private syncActive(content: string, force = false): void {
    const editor = this.active?.editor;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === content || (!force && canonical(current) === canonical(content))) return;
    editor.dispatch({ changes: changesBetween(current, content, 0), annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
  }

  // ---------- drawing ----------

  private renderContext(): CellRenderContext {
    const ctx = this.view.state.facet(noteContext);
    if (!ctx) return { resolves: () => true };
    const index = ctx.tree().links;
    const source = ctx.path();
    return { resolves: (target) => resolve(target, source, index) !== null };
  }

  private display(rows: string[][]): ((row: number, column: number) => CellDisplay | null) | null {
    const m = this.model();
    const formats = this.view.state
      .facet(tableCellFormatters)
      .map((f) => f({ rows, align: m.align }))
      .filter((f) => f !== null);
    if (formats.length === 0) return null;
    return (row, column) => {
      for (const f of formats) {
        const shown = f(row, column);
        if (shown) return shown;
      }
      return null;
    };
  }

  private grip(kind: 'row' | 'column', index: number): HTMLElement {
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.tabIndex = -1;
    grip.className = `cm-lp-grip cm-lp-grip-${kind}`;
    grip.dataset.grip = kind;
    grip.dataset.index = String(index);
    grip.setAttribute('aria-label', kind === 'row' ? (index === 0 ? 'Header row actions' : `Row ${index} actions`) : `Column ${columnName(index)} actions`);
    return grip;
  }

  private build(rows: number, columns: number, editable: boolean): void {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    const body = table.createTBody();
    this.cells = [];
    for (let r = 0; r < rows; r++) {
      const tr = r === 0 ? head : body.insertRow();
      const line: HTMLTableCellElement[] = [];
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(r === 0 ? 'th' : 'td');
        cell.className = 'cm-lp-cell';
        cell.dataset.row = String(r);
        cell.dataset.column = String(c);
        const content = document.createElement('div');
        content.className = 'cm-lp-cell-content';
        cell.appendChild(content);
        if (editable && c === 0) cell.appendChild(this.grip('row', r));
        if (editable && r === 0) cell.appendChild(this.grip('column', c));
        tr.appendChild(cell);
        line.push(cell);
      }
      this.cells.push(line);
    }
    this.scroller.replaceChildren(table);
    this.shown = this.cells.map((line) => line.map(() => '\u0000'));
  }

  private render(): void {
    const m = this.model();
    const rows = gridRows(m);
    const editable = this.editable();
    this.dom.classList.toggle('is-editable', editable);
    const a = this.active;
    const focused = a?.editor.hasFocus ?? false;
    if (this.cells.length !== rows.length || this.cells[0]?.length !== m.columns || this.shownEditable !== editable) {
      this.build(rows.length, m.columns, editable);
      this.shownEditable = editable;
    }
    if (this.shownRevision !== this.widget.revision) {
      this.shown = this.shown.map((line) => line.map(() => '\u0000'));
      this.shownRevision = this.widget.revision;
    }
    const display = this.display(rows);
    const ctx = this.renderContext();
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < m.columns; c++) {
        const cell = this.cells[r][c];
        cell.style.textAlign = m.align[c] ?? '';
        const box = cell.firstElementChild as HTMLElement;
        if (a && a.row === r && a.column === c) {
          if (a.editor.dom.parentElement !== box) box.replaceChildren(a.editor.dom);
          cell.classList.add('is-editing');
          this.shown[r][c] = '\u0000';
          continue;
        }
        cell.classList.remove('is-editing');
        const shown = display?.(r, c) ?? null;
        const key = shown ? `\u0001${shown.text}\u0001${shown.className ?? ''}\u0001${shown.title ?? ''}` : rows[r][c];
        if (this.shown[r][c] === key) continue;
        this.shown[r][c] = key;
        box.replaceChildren(shown ? renderDisplay(shown) : renderCell(rows[r][c], ctx));
        cell.classList.toggle('is-empty', !shown && rows[r][c] === '');
      }
    }
    for (let c = 0; c < m.columns; c++) this.cells[0][c].classList.toggle('is-column-active', a?.column === c);
    // Moving an editor's element (a remote change moved its cell) loses the focus; give it back.
    if (a && focused && !a.editor.hasFocus) a.editor.focus();
  }

  private moveEditorTo(row: number, column: number): void {
    const a = this.active!;
    a.row = row;
    a.column = column;
  }

  /** The column under a screen x (the first one when none is). */
  columnAt(x: number): number {
    const column = (this.cells[0] ?? []).findIndex((cell) => {
      const rect = cell.getBoundingClientRect();
      return x >= rect.left && x < rect.right;
    });
    return Math.max(0, column);
  }

  /** Where a position of the table's text is on screen (the note's caret and scrolling use it). */
  coordsAt(pos: number, _side: number): Rect | null {
    const span = cellSpans(this.model()).find((s) => pos >= s.from && pos <= s.to);
    const cell = span ? this.cells[span.row]?.[span.column] : undefined;
    if (cell) {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left + 1, right: rect.left + 1, top: rect.top, bottom: rect.bottom };
    }
    const rect = this.dom.getBoundingClientRect();
    const lineHeight = this.view.defaultLineHeight;
    return pos <= 0
      ? { left: rect.left, right: rect.left, top: rect.top, bottom: rect.top + lineHeight }
      : { left: rect.left, right: rect.left, top: rect.bottom, bottom: rect.bottom + lineHeight };
  }

  destroy(): void {
    if (this.active) this.deactivate();
    this.cancelLongPress();
    byView.get(this.view)?.delete(this);
    byDom.delete(this.dom);
  }

  // ---------- editing a cell ----------

  /** Opens a cell for editing, with the caret at `place`. */
  activate(row: number, column: number, place: Place = 'end'): boolean {
    if (!this.editable() || !this.cells[row]?.[column]) return false;
    const old = this.active;
    if (old && old.row === row && old.column === column) {
      old.editor.focus();
      this.place(old.editor, place);
      return true;
    }
    const m = this.model();
    const setup = this.view.state.facet(tableCellSetup);
    const editor = new EditorView({
      state: EditorState.create({ doc: cellContent(m, row, column), extensions: [setup ? setup() : cellLanguage, this.cellExtensions(row, column)] }),
    });
    const source = (row === 0 ? m.header : m.body[row - 1]).cells[column];
    this.active = {
      row,
      column,
      editor,
      span: this.absoluteSpan(row, column),
      pad: !m.style.padded && source && source.text !== '' ? { before: source.before, after: source.after, width: displayWidth(source.text) } : undefined,
    };
    addNestedEditor(this.view, editor);
    const cell = this.cells[row][column];
    (cell.firstElementChild as HTMLElement).replaceChildren(editor.dom);
    cell.classList.add('is-editing');
    this.shown[row][column] = '\u0000';
    editor.focus();
    this.place(editor, place);
    setActiveEditor(editor);
    // The old editor closes once the new one has the focus, so the phone's keyboard stays up; so
    // does a cell open in another table.
    if (old) this.closeEditor(old);
    for (const grid of gridsOf(this.view)) if (grid !== this) grid.deactivate();
    this.render();
    // The note's selection rests on the cell, so undo and its scrolling come back to the table.
    const span = this.active.span;
    if (span) this.view.dispatch({ selection: EditorSelection.cursor(span.from), annotations: tableEdit.of(this.id) });
    return true;
  }

  /** Closes the cell editor; the cell shows its content again. */
  deactivate(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.closeEditor(a);
    if (this.shown[a.row]?.[a.column] !== undefined) this.shown[a.row][a.column] = '\u0000';
    this.render();
  }

  private closeEditor(a: ActiveCell): void {
    const hadFocus = a.editor.hasFocus;
    removeNestedEditor(this.view, a.editor);
    if (activeEditor() === a.editor) setActiveEditor(this.view);
    a.editor.destroy();
    if (hadFocus && !this.active) this.view.state.facet(noteContext)?.save();
  }

  private place(editor: EditorView, place: Place): void {
    const length = editor.state.doc.length;
    let selection: EditorSelection;
    if (place === 'start') selection = EditorSelection.single(0);
    else if (place === 'all') selection = EditorSelection.single(0, length);
    else if (place === 'end') selection = EditorSelection.single(length);
    else selection = EditorSelection.single(editor.posAtCoords(place) ?? length);
    editor.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
  }

  private cellExtensions(row: number, column: number): Extension {
    return [
      tableCellHost.of(this.view),
      EditorView.contentAttributes.of({ 'aria-label': cellLabel(row, column) }),
      singleLine,
      Prec.high(
        keymap.of([
          { key: 'Tab', run: () => this.step(1) },
          { key: 'Shift-Tab', run: () => this.step(-1) },
          { key: 'Enter', run: () => this.down(1) },
          { key: 'Shift-Enter', run: () => this.down(-1) },
          { key: 'Escape', run: () => this.leave('after') },
          { key: 'ArrowUp', run: (e) => this.vertical(e, -1) },
          { key: 'ArrowDown', run: (e) => this.vertical(e, 1) },
          { key: 'ArrowLeft', run: (e) => this.horizontal(e, -1) },
          { key: 'ArrowRight', run: (e) => this.horizontal(e, 1) },
          { key: 'Mod-z', run: () => undo(this.view), preventDefault: true },
          { key: 'Mod-y', mac: 'Mod-Shift-z', run: () => redo(this.view), preventDefault: true },
          { key: 'Mod-f', run: () => openSearchPanel(this.view), preventDefault: true },
          { key: 'Shift-F10', run: () => this.menuForActive() },
          { key: 'ContextMenu', run: () => this.menuForActive() },
        ]),
      ),
      EditorView.updateListener.of((update) => this.onCellUpdate(update)),
    ];
  }

  private onCellUpdate(update: ViewUpdate): void {
    const a = this.active;
    if (!a || update.view !== a.editor) return;
    if (update.docChanged && update.transactions.some((tr) => tr.docChanged && !tr.annotation(Transaction.remote))) {
      const tr = [...update.transactions].reverse().find((t) => t.docChanged);
      this.write(tr?.annotation(Transaction.userEvent) ?? 'input');
    }
    if (update.focusChanged) {
      if (update.view.hasFocus) setActiveEditor(update.view);
      else
        // Leaving the table for another part of the app saves, as leaving the note's editor does.
        setTimeout(() => {
          if (!this.dom.contains(document.activeElement)) this.view.state.facet(noteContext)?.save();
        }, 0);
    }
  }

  /** Writes the edited cell's text into the note. */
  private write(userEvent: string): void {
    const a = this.active;
    if (!a) return;
    const content = a.editor.state.doc.toString();
    const { row, column, pad } = a;
    if (!this.apply((m) => setCell(m, row, column, content, pad), userEvent, true)) {
      // Refused: the cell shows what the note holds.
      this.syncActive(cellContent(this.model(), row, column), true);
    }
  }

  /**
   * Applies an edit of the table model: checks that the new text reads as the model says (or
   * refuses it), then writes the minimal changes as one transaction. Typing joins the undo step of
   * the typing before it, as in the rest of the note; anything else is a step of its own.
   */
  private apply(change: (m: TableModel) => TableModel, userEvent: string, typing: boolean): boolean {
    if (!this.editable()) return false;
    const from = this.from();
    const { text, model } = this.widget.block;
    if (from === null || this.view.state.sliceDoc(from, from + text.length) !== text) return false;
    const next = change(model);
    if (next === model) return false;
    const written = serializeTable(next);
    if (written === text) return true;
    if (!isSerializationOf(next, written)) {
      toast('That edit would change how the table reads, so it was not made');
      return false;
    }
    this.view.dispatch({
      changes: changesBetween(text, written, from),
      annotations: [tableEdit.of(this.id), Transaction.userEvent.of(userEvent), ...(typing ? [] : [isolateHistory.of('full')])],
    });
    return true;
  }

  /**
   * A change of the table's shape. A cell being edited stays open where it went (`target`), or in
   * the cell `target` names; without an open cell, nothing takes the focus unless `focus` is set.
   */
  private structural(change: (m: TableModel) => TableModel, target: { row: number; column: number; place?: Place } | null, focus = false): boolean {
    const from = this.from();
    const editing = this.active !== null;
    if (from === null || !this.apply(change, 'input.table', false)) return false;
    const grid = gridAt(this.view, from);
    if (grid && target && (editing || focus)) grid.activate(target.row, target.column, target.place ?? 'end');
    return true;
  }

  /** Tab and Shift-Tab: the next or previous cell, row by row; Tab in the last cell adds a row. */
  step(delta: 1 | -1): boolean {
    const a = this.active;
    if (!a) return false;
    const m = this.model();
    const rows = rowCount(m);
    const index = a.row * m.columns + a.column + delta;
    if (index < 0) return true;
    if (index >= rows * m.columns) return this.structural((t) => insertRow(t, rows), { row: rows, column: 0, place: 'start' });
    return this.activate(Math.floor(index / m.columns), index % m.columns, 'all');
  }

  /** Enter and Shift-Enter: the cell below or above; Enter in the last row adds a row. */
  down(delta: 1 | -1): boolean {
    const a = this.active;
    if (!a) return false;
    const rows = rowCount(this.model());
    const row = a.row + delta;
    if (row < 0) return true;
    if (row >= rows) return this.structural((t) => insertRow(t, rows), { row: rows, column: a.column, place: 'start' });
    return this.activate(row, a.column, 'end');
  }

  /** Arrow keys at the edge of a cell move to the next cell, and out of the table at its edge. */
  private vertical(editor: EditorView, dir: 1 | -1): boolean {
    const a = this.active;
    const sel = editor.state.selection.main;
    if (!a || !sel.empty) return false;
    // A cell whose text wraps keeps the caret inside until its first or last line.
    const edge = editor.coordsAtPos(dir < 0 ? 0 : editor.state.doc.length);
    const here = editor.coordsAtPos(sel.head);
    if (edge && here && Math.abs(edge.top - here.top) > 2) return false;
    const row = a.row + dir;
    if (row < 0) return this.leave('before');
    if (row >= rowCount(this.model())) return this.leave('after');
    const cell = this.cells[row]?.[a.column]?.getBoundingClientRect();
    const place: Place = here && cell && cell.width > 0 ? { x: here.left, y: dir > 0 ? cell.top + 4 : cell.bottom - 4 } : 'end';
    return this.activate(row, a.column, place);
  }

  private horizontal(editor: EditorView, dir: 1 | -1): boolean {
    const a = this.active;
    const sel = editor.state.selection.main;
    if (!a || !sel.empty || sel.head !== (dir < 0 ? 0 : editor.state.doc.length)) return false;
    const m = this.model();
    const index = a.row * m.columns + a.column + dir;
    if (index < 0) return this.leave('before');
    if (index >= rowCount(m) * m.columns) return this.leave('after');
    return this.activate(Math.floor(index / m.columns), index % m.columns, dir < 0 ? 'end' : 'start');
  }

  /**
   * Escape: back to the note, on the line after the table (or before it). A table that ends (or
   * starts) the note gets an empty line there first: a caret cannot sit against the table itself.
   */
  leave(side: 'before' | 'after'): boolean {
    const from = this.from();
    if (from === null) return false;
    const to = from + this.widget.block.text.length;
    const length = this.view.state.doc.length;
    this.deactivate();
    this.view.focus();
    const annotations = tableEdit.of(this.id);
    if (side === 'after' ? to < length : from > 0) {
      this.view.dispatch({ selection: EditorSelection.cursor(side === 'after' ? to + 1 : from - 1), scrollIntoView: true, userEvent: 'select', annotations });
    } else {
      const at = side === 'after' ? to : from;
      this.view.dispatch({ changes: { from: at, insert: '\n' }, selection: EditorSelection.cursor(side === 'after' ? at + 1 : at), scrollIntoView: true, userEvent: 'input', annotations });
    }
    return true;
  }

  // ---------- menus ----------

  private menuForActive(): boolean {
    const a = this.active;
    if (!a) return false;
    const rect = this.cells[a.row][a.column].getBoundingClientRect();
    this.openMenu(a.row, a.column, rect.left, rect.bottom, 'cell');
    return true;
  }

  /** The row, column and cell menus (a grip's click, a right-click, a long-press). */
  menuItems(row: number, column: number, kind: 'cell' | 'row' | 'column'): EditorMenuEntry[] {
    const m = this.model();
    const last = rowCount(m) - 1;
    const columns = m.columns;
    const a = this.active;
    // The cell being edited stays open where its content goes.
    const followRow = (from: number, to: number) => (a ? { row: movedIndex(a.row, from, to), column: a.column } : null);
    const followColumn = (from: number, to: number) => (a ? { row: a.row, column: movedIndex(a.column, from, to) } : null);
    const afterRowDelete = a ? { row: a.row === row ? Math.min(row, last - 1) : a.row > row ? a.row - 1 : a.row, column: a.column } : null;
    const afterColumnDelete = a ? { row: a.row, column: a.column === column ? Math.min(column, columns - 2) : a.column > column ? a.column - 1 : a.column } : null;
    const rowItems: EditorMenuEntry[] = [
      { id: 'row-above', label: 'Insert row above', disabled: row === 0, run: () => this.structural((t) => insertRow(t, row), { row, column }, true) },
      { id: 'row-below', label: 'Insert row below', run: () => this.structural((t) => insertRow(t, row + 1), { row: row + 1, column }, true) },
      { id: 'row-up', label: 'Move row up', disabled: row <= 1, run: () => this.structural((t) => moveRow(t, row, row - 1), followRow(row, row - 1)) },
      { id: 'row-down', label: 'Move row down', disabled: row === 0 || row === last, run: () => this.structural((t) => moveRow(t, row, row + 1), followRow(row, row + 1)) },
      {
        id: 'row-delete',
        label: 'Delete row',
        danger: true,
        disabled: row === 0,
        run: () => this.structural((t) => deleteRow(t, row), afterRowDelete),
      },
    ];
    const columnItems: EditorMenuEntry[] = [
      { id: 'column-left', label: 'Insert column left', run: () => this.structural((t) => insertColumn(t, column), { row, column }, true) },
      { id: 'column-right', label: 'Insert column right', run: () => this.structural((t) => insertColumn(t, column + 1), { row, column: column + 1 }, true) },
      { id: 'column-move-left', label: 'Move column left', disabled: column === 0, run: () => this.structural((t) => moveColumn(t, column, column - 1), followColumn(column, column - 1)) },
      {
        id: 'column-move-right',
        label: 'Move column right',
        disabled: column === columns - 1,
        run: () => this.structural((t) => moveColumn(t, column, column + 1), followColumn(column, column + 1)),
      },
      {
        id: 'column-delete',
        label: 'Delete column',
        danger: true,
        disabled: columns <= 1,
        run: () => this.structural((t) => deleteColumn(t, column), afterColumnDelete),
      },
    ];
    const aligns: Array<[Align, string]> = [
      ['left', 'Align left'],
      ['center', 'Align center'],
      ['right', 'Align right'],
      [null, 'No alignment'],
    ];
    const alignItems: EditorMenuEntry[] = aligns.map(([align, label]) => ({
      id: `align-${align ?? 'none'}`,
      label,
      disabled: m.align[column] === align,
      run: () => void this.structural((t) => setAlign(t, column, align), a ? { row: a.row, column: a.column } : null),
    }));
    const tableItems: EditorMenuEntry[] = [{ id: 'table-delete', label: 'Delete table', danger: true, run: () => void this.deleteTable() }];
    if (kind === 'row') return [...rowItems, 'separator', ...tableItems];
    if (kind === 'column') return [...columnItems, 'separator', ...alignItems];
    return [...rowItems, 'separator', ...columnItems, 'separator', ...alignItems, 'separator', ...tableItems];
  }

  private openMenu(row: number, column: number, x: number, y: number, kind: 'cell' | 'row' | 'column'): void {
    const ctx = this.view.state.facet(noteContext);
    if (!ctx || !this.editable()) return;
    const label = kind === 'row' ? (row === 0 ? 'Header row' : `Row ${row}`) : kind === 'column' ? `Column ${columnName(column)}` : cellLabel(row, column);
    ctx.showMenu({ x, y }, label, this.menuItems(row, column, kind));
  }

  /** Removes the whole table (one undo step), with the line break after it. */
  deleteTable(): boolean {
    const from = this.from();
    if (from === null || !this.editable()) return false;
    const to = from + this.widget.block.text.length;
    const length = this.view.state.doc.length;
    const range = to < length ? { from, to: to + 1 } : { from: Math.max(0, from - 1), to };
    this.deactivate();
    this.view.dispatch({
      changes: range,
      selection: EditorSelection.cursor(range.from),
      annotations: [tableEdit.of(this.id), Transaction.userEvent.of('delete.table'), isolateHistory.of('full')],
    });
    return true;
  }

  // ---------- pointer ----------

  private cellAt(target: EventTarget | null): { row: number; column: number; el: HTMLElement } | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('.cm-lp-cell') : null;
    if (!el || !this.dom.contains(el)) return null;
    return { row: Number(el.dataset.row), column: Number(el.dataset.column), el };
  }

  private inEditor(target: EventTarget | null): boolean {
    return target instanceof Node && this.active !== null && this.active.editor.dom.contains(target);
  }

  /** Follows the link or tag at `pos` of a cell's content. */
  private follow(row: number, column: number, pos: number): void {
    const content = cellContent(this.model(), row, column);
    const state = EditorState.create({ doc: content, extensions: cellLanguage });
    ensureSyntaxTree(state, content.length, 1000);
    const hit = linkAt(state, pos + 1);
    if (hit) followLink(this.view, hit);
  }

  private onMouseDown = (e: MouseEvent) => {
    // The grid handles its clicks itself: the note's editor does not take the focus or the selection.
    if (this.editable() && !this.inEditor(e.target)) e.preventDefault();
  };

  private onClick = (e: MouseEvent) => {
    if (e.button !== 0 || this.inEditor(e.target)) return;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const target = e.target as Element;
    if (target.closest?.('.cm-lp-grip')) return;
    const cell = this.cellAt(target);
    if (!cell) return;
    const editable = this.editable();
    const link = target.closest<HTMLElement>('.cm-lp-link, .cm-hashtag');
    // Links follow on a tap, on Mod-click, or on a click in a locked note (not one ending a text selection).
    if (link && (modKey(e) || this.lastPointer === 'touch' || (!editable && (window.getSelection()?.isCollapsed ?? true)))) {
      e.preventDefault();
      this.follow(cell.row, cell.column, Number(link.dataset.pos));
      return;
    }
    if (!editable) return;
    e.preventDefault();
    this.activate(cell.row, cell.column, { x: e.clientX, y: e.clientY });
  };

  private onContextMenu = (e: MouseEvent) => {
    // A locked table and the editor of a cell keep the browser's menu (copy, spelling).
    if (!this.editable() || this.inEditor(e.target)) return;
    const cell = this.cellAt(e.target);
    if (!cell) return;
    e.preventDefault();
    this.cancelLongPress();
    const grip = (e.target as Element).closest<HTMLElement>('.cm-lp-grip');
    const kind = grip ? (grip.dataset.grip as 'row' | 'column') : 'cell';
    this.openMenu(cell.row, cell.column, e.clientX, e.clientY, kind);
  };

  private cancelLongPress(): void {
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  private onPointerDown = (e: PointerEvent) => {
    this.lastPointer = e.pointerType || 'mouse';
    this.suppressClick = false;
    const grip = e.target instanceof Element ? e.target.closest<HTMLElement>('.cm-lp-grip') : null;
    if (grip && this.editable() && e.button === 0) {
      e.preventDefault();
      grip.setPointerCapture?.(e.pointerId);
      const kind = grip.dataset.grip as 'row' | 'column';
      const index = Number(grip.dataset.index);
      this.drag = { kind, index, x: e.clientX, y: e.clientY, moved: false, target: index, grip };
      return;
    }
    if (e.pointerType !== 'touch' || !this.editable() || this.inEditor(e.target)) return;
    const cell = this.cellAt(e.target);
    if (!cell) return;
    this.cancelLongPress();
    const { clientX: x, clientY: y } = e;
    this.longPress = {
      x,
      y,
      timer: setTimeout(() => {
        this.longPress = null;
        this.suppressClick = true;
        this.openMenu(cell.row, cell.column, x, y, 'cell');
      }, LONG_PRESS_MS),
    };
  };

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (d) {
      const movable = d.kind === 'column' || d.index > 0;
      if (!d.moved && movable && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_THRESHOLD) {
        d.moved = true;
        this.dom.classList.add('is-dragging');
      }
      if (d.moved) this.dragTo(d, e);
      return;
    }
    const lp = this.longPress;
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > LONG_PRESS_SLOP) this.cancelLongPress();
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) {
      this.cancelLongPress();
      return;
    }
    this.drag = null;
    this.indicator.hidden = true;
    this.dom.classList.remove('is-dragging');
    if (!d.moved) {
      const rect = d.grip.getBoundingClientRect();
      const cell = this.cellAt(d.grip)!;
      this.openMenu(cell.row, cell.column, rect.left, rect.bottom, d.kind);
      return;
    }
    this.suppressClick = true;
    if (d.target === d.index) return;
    const a = this.active;
    if (d.kind === 'row') this.structural((t) => moveRow(t, d.index, d.target), a ? { row: movedIndex(a.row, d.index, d.target), column: a.column } : null);
    else this.structural((t) => moveColumn(t, d.index, d.target), a ? { row: a.row, column: movedIndex(a.column, d.index, d.target) } : null);
    e.preventDefault();
  };

  private onPointerCancel = () => {
    this.cancelLongPress();
    this.drag = null;
    this.indicator.hidden = true;
    this.dom.classList.remove('is-dragging');
  };

  /** Shows where a dragged row or column would go. */
  private dragTo(d: Drag, e: PointerEvent): void {
    const box = this.dom.getBoundingClientRect();
    const table = this.scroller.firstElementChild!.getBoundingClientRect();
    const m = this.model();
    if (d.kind === 'row') {
      const last = rowCount(m) - 1;
      let slot = last + 1;
      for (let r = 1; r <= last; r++) {
        const rect = this.cells[r][0].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          slot = r;
          break;
        }
      }
      d.target = Math.min(Math.max(slot > d.index ? slot - 1 : slot, 1), last);
      const edge = slot <= last ? this.cells[slot][0].getBoundingClientRect().top : this.cells[last][0].getBoundingClientRect().bottom;
      Object.assign(this.indicator.style, { left: `${table.left - box.left}px`, top: `${edge - box.top - 1}px`, width: `${table.width}px`, height: '2px' });
    } else {
      let slot = m.columns;
      for (let c = 0; c < m.columns; c++) {
        const rect = this.cells[0][c].getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
          slot = c;
          break;
        }
      }
      d.target = Math.min(Math.max(slot > d.index ? slot - 1 : slot, 0), m.columns - 1);
      const edge = slot < m.columns ? this.cells[0][slot].getBoundingClientRect().left : this.cells[0][m.columns - 1].getBoundingClientRect().right;
      Object.assign(this.indicator.style, { left: `${edge - box.left - 1}px`, top: `${table.top - box.top}px`, width: '2px', height: `${table.height}px` });
    }
    this.indicator.hidden = false;
  }

  private onPointerOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const cell = this.cellAt(e.target);
    this.setHoverColumn(cell ? cell.column : -1);
  };

  private onPointerLeave = () => this.setHoverColumn(-1);

  private setHoverColumn(column: number): void {
    if (column === this.hoverColumn) return;
    this.cells[0]?.[this.hoverColumn]?.classList.remove('is-column-hover');
    this.hoverColumn = column;
    this.cells[0]?.[column]?.classList.add('is-column-hover');
  }

  private onDragOver = (e: DragEvent) => {
    // Files dropped on a table would land inside its text; the drop is refused here.
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    }
  };

  private onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    toast('Drop files outside the table to add them to the note');
  };
}
