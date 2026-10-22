import { undo } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../../../api/mock/vault';
import { buildVaultTree } from '../../../api/vaultTree';
import { DEFAULT_SETTINGS } from '../../../features/settings';
import { DocumentSession } from '../../../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../../../test/fakes';
import { activeEditor, setActiveEditor } from '../../activeEditor';
import type { EditorMenuEntry, NoteContext } from '../../context';
import { noteExtensions } from '../../editorSetup';
import { markdownNoteLanguage } from '../../language';
import { remoteTransaction } from '../../remote';
import type { LivePreviewConfig } from '../decorations';
import { tableEdit } from './facets';
import { gridOf, type TableGrid } from './grid';
import { insertTable, moveToCell, refreshTables, tableBlocks, tableCellFormatters, tables, type TableCellFormatter } from './index';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  setActiveEditor(null);
  vi.restoreAllMocks();
});

const tree = buildVaultTree({
  eventId: 'b.1',
  folders: [],
  files: [{ path: 'Note.md', name: 'Note.md', basename: 'Note', extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] }],
});

interface Menu {
  label: string;
  items: EditorMenuEntry[];
}

interface Options {
  config?: Partial<LivePreviewConfig> | null;
  readOnly?: boolean;
  ctx?: Partial<NoteContext>;
  formatter?: TableCellFormatter;
}

function context(menus: Menu[], overrides: Partial<NoteContext> = {}): NoteContext {
  return {
    path: () => 'Here.md',
    tree: () => tree,
    settings: () => DEFAULT_SETTINGS,
    openLink: () => {},
    openTag: () => {},
    noteMeta: () => Promise.reject(new Error('unused')),
    vaultTags: async () => [],
    recentPaths: () => [],
    save: () => {},
   
    insertFiles: () => {},
    linkTo: (p) => `[[${p}]]`,
    showMenu: (_at, label, items) => menus.push({ label, items }),
    renderEmbed: () => () => {},
    renderProperties: () => () => {},
    ...overrides,
  };
}

/** A note editor in Live Preview (or source mode with `config: null`), with `‸` marking the cursor. */
function editor(marked: string, { config = {}, readOnly = false, ctx, formatter }: Options = {}): EditorView & { menus: Menu[] } {
  const cursor = marked.indexOf('‸');
  const doc = cursor >= 0 ? marked.slice(0, cursor) + marked.slice(cursor + 1) : marked;
  const menus: Menu[] = [];
  const livePreview = config === null ? null : { visibility: 'hide-all' as const, locked: false, checkboxes: !readOnly, ...config };
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(Math.max(0, cursor)),
    extensions: [
      noteExtensions(context(menus, ctx), { onLocalChange: () => {}, onBlur: () => {}, readOnly, spellcheck: false, autocorrect: false, livePreview }),
      formatter ? tableCellFormatters.of(formatter) : [],
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  // The language parses in the background; make sure the field saw the whole tree.
  view.dispatch({ effects: refreshTables.of(null) });
  return Object.assign(view, { menus });
}

function grids(view: EditorView): TableGrid[] {
  return [...view.dom.querySelectorAll('.cm-lp-table')].map((el) => gridOf(el)!);
}

function grid(view: EditorView, i = 0): TableGrid {
  const g = grids(view)[i];
  if (!g) throw new Error('no grid');
  return g;
}

/** The grid's cells as shown: header row first. */
function shown(view: EditorView, i = 0): string[][] {
  const table = view.dom.querySelectorAll('.cm-lp-table')[i];
  return [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('.cm-lp-cell-content')].map((c) => c.textContent ?? ''));
}

function cellEditor(view: EditorView, i = 0): EditorView {
  const active = grid(view, i).activeCell();
  if (!active) throw new Error('no cell being edited');
  return active.editor;
}

function type(view: EditorView, s: string): void {
  view.dispatch(view.state.replaceSelection(s), { userEvent: 'input.type' });
}

function press(view: EditorView, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...mods }), 'editor');
}

const TABLE = '| Name | Qty |\n|:-----|----:|\n| Tea  |   2 |\n| Milk |  10 |';

describe('tables render as grids (ROADMAP 10a)', () => {
  it('shows a table as a grid, with the header styled and the delimiter row’s alignment', () => {
    const view = editor(`Intro\n\n${TABLE}\n\nAfter`);
    expect(shown(view)).toEqual([
      ['Name', 'Qty'],
      ['Tea', '2'],
      ['Milk', '10'],
    ]);
    const cells = view.dom.querySelectorAll<HTMLElement>('.cm-lp-cell');
    expect(cells[0].tagName).toBe('TH');
    expect(cells[2].tagName).toBe('TD');
    expect(cells[0].style.textAlign).toBe('left');
    expect(cells[1].style.textAlign).toBe('right');
    // The text around the table is still the editor's text.
    expect(view.contentDOM.textContent).toContain('Intro');
    expect(view.contentDOM.textContent).toContain('After');
  });

  it('renders inline formatting inside cells', () => {
    const view = editor('| a | b | c |\n|---|---|---|\n| **bold** | [site](https://x.com) | `x \\| y` |\n| [[Note|alias]] | [[Missing]] | ==hi== %%hidden%% |'.replace('[[Note|alias]]', '[[Note\\|alias]]'));
    const table = view.dom.querySelector('.cm-lp-table')!;
    expect(table.querySelector('strong')?.textContent).toBe('bold');
    expect(table.querySelector('.cm-lp-link')?.textContent).toBe('site');
    expect(table.querySelector('code')?.textContent).toBe('x | y');
    expect(table.querySelector('mark')?.textContent).toBe('hi');
    const links = [...table.querySelectorAll('.cm-lp-link')].map((l) => [l.textContent, l.classList.contains('cm-unresolved')]);
    expect(links).toEqual([
      ['site', false],
      ['alias', false],
      ['Missing', true],
    ]);
    expect(table.textContent).not.toContain('hidden');
  });

  it('leaves tables inside quotes and lists as text', () => {
    const view = editor('> | a |\n> |---|\n> | b |\n\n- item\n\n  | c |\n  |---|');
    expect(grids(view)).toHaveLength(0);
  });

  it('keeps a table in place, mapped through an edit, while the parse catches up', () => {
    const doc = `${TABLE}\n\n${Array.from({ length: 5000 }, (_, i) => `Line ${i} with *some* text`).join('\n')}`;
    let state = EditorState.create({ doc, extensions: [markdownNoteLanguage(), tables({ locked: false })] });
    ensureSyntaxTree(state, state.doc.length, 60000);
    state = state.update({ effects: refreshTables.of(null) }).state;
    expect(tableBlocks(state)).toHaveLength(1);
    const typed = state.update({ changes: { from: 2, insert: 'x' } }).state;
    // The parse has not reached past the table yet; the grid stays, with the new text.
    expect(syntaxTreeAvailable(typed, TABLE.length + 2)).toBe(false);
    expect(tableBlocks(typed).map((b) => b.text)).toEqual([`| xName | Qty |${TABLE.slice(TABLE.indexOf('\n'))}`]);
    // A table whose text no longer reads as one goes at once.
    const broken = state.update({ changes: { from: TABLE.indexOf('|:'), to: TABLE.indexOf('|:') + 1, insert: 'x' } }).state;
    expect(tableBlocks(broken)).toHaveLength(0);
  });

  it('shows the raw table in source mode', () => {
    const view = editor(TABLE, { config: null });
    expect(grids(view)).toHaveLength(0);
    expect(view.contentDOM.textContent).toContain('|:-----|----:|');
  });

  it('shows the grid read-only in a locked note: no editing, no grips', () => {
    const view = editor(TABLE, { config: { locked: true } });
    expect(grids(view)).toHaveLength(1);
    expect(view.dom.querySelector('.cm-lp-grip')).toBeNull();
    view.dom.querySelectorAll<HTMLElement>('td')[0].click();
    expect(grid(view).activeCell()).toBeNull();
    expect(grid(view).activate(1, 0)).toBe(false);
  });

  it('follows a link in a locked note’s cell on a click', () => {
    const openLink = vi.fn();
    const view = editor('| a |\n|---|\n| [[Note]] |', { config: { locked: true }, ctx: { openLink } });
    view.dom.querySelector<HTMLElement>('td .cm-lp-link')!.click();
    expect(openLink).toHaveBeenCalledWith('Note', null);
  });

  it('follows a link in a cell on a tap or Mod-click while editing; a plain click edits the cell', () => {
    const openLink = vi.fn();
    const view = editor('| a |\n|---|\n| see [[Note]] |', { ctx: { openLink } });
    const link = () => view.dom.querySelector<HTMLElement>('td .cm-lp-link')!;
    link().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    link().click();
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(grid(view).activeCell()).toBeNull();
    link().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    link().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(openLink).toHaveBeenCalledTimes(2);
    link().click();
    expect(openLink).toHaveBeenCalledTimes(2);
    expect(cellEditor(view).state.doc.toString()).toBe('see [[Note]]');
  });

  it('keeps one cell open at a time, across tables', () => {
    const view = editor(`${TABLE}\n\n| x |\n|---|\n| y |`);
    grid(view, 0).activate(1, 0);
    grid(view, 1).activate(1, 0);
    expect(grid(view, 0).activeCell()).toBeNull();
    expect(grid(view, 1).activeCell()).toMatchObject({ row: 1, column: 0 });
    expect(view.dom.querySelectorAll('.cm-lp-cell .cm-editor')).toHaveLength(1);
  });

  it('shows a formatter’s value instead of the Markdown, and the text while editing (ROADMAP 39)', () => {
    const formatter: TableCellFormatter = (table) => (row, column) => (table.rows[row][column].startsWith('=') ? { text: '42', className: 'is-number', title: 'computed' } : null);
    const view = editor('| a | b |\n|---|---|\n| 1 | =A2*42 |', { formatter });
    expect(shown(view)[1]).toEqual(['1', '42']);
    const value = view.dom.querySelector<HTMLElement>('.cm-lp-cell-value')!;
    expect(value.className).toBe('cm-lp-cell-value is-number');
    expect(value.title).toBe('computed');
    grid(view).activate(1, 1);
    expect(cellEditor(view).state.doc.toString()).toBe('=A2*42');
  });
});

describe('editing a cell', () => {
  it('opens a cell on a click and writes what you type into the table, and only that table', () => {
    const doc = `Intro\n\n${TABLE}\n\nMiddle\n\n| x |\n|---|\n| y |`;
    const view = editor(doc);
    view.dom.querySelectorAll<HTMLElement>('td')[0].click();
    const cell = cellEditor(view);
    expect(cell.state.doc.toString()).toBe('Tea');
    expect(activeEditor()).toBe(cell);
    cell.dispatch({ selection: EditorSelection.cursor(3) });
    type(cell, 's');
    expect(view.state.doc.toString()).toBe(doc.replace('| Tea  |', '| Teas |'));
    type(cell, ' leaves');
    expect(view.state.doc.toString()).toBe(
      'Intro\n\n| Name        | Qty |\n|:------------|----:|\n| Teas leaves |   2 |\n| Milk        |  10 |\n\nMiddle\n\n| x |\n|---|\n| y |',
    );
  });

  it('escapes a pipe typed in a cell', () => {
    const view = editor('| a | b |\n|---|---|\n| c | d |');
    grid(view).activate(1, 1);
    type(cellEditor(view), ' | e');
    expect(view.state.doc.toString()).toBe('| a | b      |\n|---|--------|\n| c | d \\| e |');
    expect(shown(view)[1]).toEqual(['c', 'd | e']);
  });

  it('keeps a pasted line break out of the table', () => {
    const view = editor('| a | b |\n|---|---|\n| c | d |');
    grid(view).activate(1, 0, 'end');
    const cell = cellEditor(view);
    cell.dispatch(cell.state.replaceSelection('1\n2'), { userEvent: 'input.paste' });
    expect(cell.state.doc.toString()).toBe('c1 2');
    expect(view.state.doc.toString()).toBe('| a    | b |\n|------|---|\n| c1 2 | d |');
  });

  it('types into a cell missing from a short row', () => {
    const view = editor('| a | b |\n|---|---|\n| c |\n\nnext');
    grid(view).activate(1, 1);
    type(cellEditor(view), 'd');
    expect(view.state.doc.toString()).toBe('| a | b |\n|---|---|\n| c | d |\n\nnext');
  });

  it('undoes typing in a cell from the cell, as the note’s history', () => {
    const view = editor(TABLE);
    grid(view).activate(1, 0, 'end');
    const cell = cellEditor(view);
    type(cell, 's');
    type(cell, '!');
    expect(view.state.doc.toString()).toContain('Teas!');
    press(cell, 'z', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe(TABLE);
    expect(cellEditor(view).state.doc.toString()).toBe('Tea');
  });

  it('finds in the note from a cell', () => {
    const view = editor(TABLE);
    grid(view).activate(1, 0);
    press(cellEditor(view), 'f', { ctrlKey: true });
    expect(view.dom.querySelector('.cm-search')).not.toBeNull();
    expect(cellEditor(view).dom.querySelector('.cm-search')).toBeNull();
  });

  it('marks the note changed and keeps the note’s selection on the cell', () => {
    const onLocalChange = vi.fn();
    const state = EditorState.create({
      doc: `x\n\n${TABLE}`,
      extensions: noteExtensions(context([]), { onLocalChange, onBlur: () => {}, readOnly: false, spellcheck: false, autocorrect: false, livePreview: { visibility: 'hide-all', locked: false, checkboxes: true } }),
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    view.dispatch({ effects: refreshTables.of(null) });
    grid(view).activate(2, 1);
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('  10'));
    type(cellEditor(view), '0');
    expect(onLocalChange).toHaveBeenCalled();
  });
});

describe('moving between cells', () => {
  it('Tab and Shift-Tab move along the rows; Tab in the last cell adds a row', () => {
    const view = editor('| a | b |\n|---|---|\n| c | d |\n\nnext');
    grid(view).activate(0, 0);
    press(cellEditor(view), 'Tab');
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 1 });
    press(cellEditor(view), 'Tab');
    expect(grid(view).activeCell()).toMatchObject({ row: 1, column: 0 });
    press(cellEditor(view), 'Tab', { shiftKey: true });
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 1 });
    grid(view).activate(1, 1);
    press(cellEditor(view), 'Tab');
    expect(view.state.doc.toString()).toBe('| a | b |\n|---|---|\n| c | d |\n|   |   |\n\nnext');
    expect(grid(view).activeCell()).toMatchObject({ row: 2, column: 0 });
    type(cellEditor(view), 'e');
    expect(view.state.doc.toString()).toBe('| a | b |\n|---|---|\n| c | d |\n| e |   |\n\nnext');
  });

  it('Enter moves down, adding a row at the end; Shift-Enter moves up', () => {
    const view = editor('| a | b |\n|---|---|\n| c | d |');
    grid(view).activate(0, 1);
    press(cellEditor(view), 'Enter');
    expect(grid(view).activeCell()).toMatchObject({ row: 1, column: 1 });
    press(cellEditor(view), 'Enter');
    expect(view.state.doc.toString()).toBe('| a | b |\n|---|---|\n| c | d |\n|   |   |');
    expect(grid(view).activeCell()).toMatchObject({ row: 2, column: 1 });
    press(cellEditor(view), 'Enter', { shiftKey: true });
    expect(grid(view).activeCell()).toMatchObject({ row: 1, column: 1 });
  });

  it('Escape leaves the table, with the caret on the line after it', () => {
    const view = editor(`${TABLE}\n\nAfter`);
    grid(view).activate(1, 0);
    press(cellEditor(view), 'Escape');
    expect(grid(view).activeCell()).toBeNull();
    expect(view.state.selection.main.head).toBe(TABLE.length + 1);
    expect(activeEditor()).toBe(view);
  });

  it('arrow keys cross cell edges, and leave the table at its edges', () => {
    const view = editor(`Before\n${TABLE}\n\nAfter`);
    grid(view).activate(0, 0, 'end');
    press(cellEditor(view), 'ArrowRight');
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 1 });
    press(cellEditor(view), 'ArrowDown');
    expect(grid(view).activeCell()).toMatchObject({ row: 1, column: 1 });
    press(cellEditor(view), 'ArrowUp');
    press(cellEditor(view), 'ArrowUp');
    expect(grid(view).activeCell()).toBeNull();
    expect(view.state.selection.main.head).toBe('Before'.length);
  });

  it('ArrowDown from the line above, and ArrowLeft from the line after, enter the table', () => {
    const view = editor(`Above‸\n${TABLE}\nX\n\nafter`.replace('\nX\n', '\n'));
    press(view, 'ArrowDown');
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 0 });
    press(cellEditor(view), 'Escape');
    press(view, 'ArrowLeft');
    expect(grid(view).activeCell()).toMatchObject({ row: 2, column: 1 });
  });

  it('the phone toolbar’s Next and Previous move between cells', () => {
    const view = editor('| a | b |\n|---|---|\n| c | d |');
    grid(view).activate(0, 0);
    expect(moveToCell(cellEditor(view), 1)).toBe(true);
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 1 });
    expect(moveToCell(cellEditor(view), -1)).toBe(true);
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 0 });
  });
});

describe('rows and columns', () => {
  function run(view: EditorView & { menus: Menu[] }, id: string): void {
    const item = view.menus.at(-1)!.items.find((i) => i !== 'separator' && i.id === id);
    if (!item || item === 'separator') throw new Error(`no menu item ${id}`);
    expect(item.disabled ?? false).toBe(false);
    item.run();
  }

  function openMenu(view: EditorView, row: number, column: number): void {
    const cell = view.dom.querySelector<HTMLElement>(`.cm-lp-cell[data-row="${row}"][data-column="${column}"]`)!;
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  }

  it('opens the cell menu on a right-click, with the row, column, alignment and table actions', () => {
    const view = editor(TABLE);
    openMenu(view, 1, 0);
    expect(view.menus).toHaveLength(1);
    const ids = view.menus[0].items.map((i) => (i === 'separator' ? '-' : i.id));
    expect(ids).toEqual([
      'row-above',
      'row-below',
      'row-up',
      'row-down',
      'row-delete',
      '-',
      'column-left',
      'column-right',
      'column-move-left',
      'column-move-right',
      'column-delete',
      '-',
      'align-left',
      'align-center',
      'align-right',
      'align-none',
      '-',
      'table-delete',
    ]);
    const disabled = view.menus[0].items.filter((i) => i !== 'separator' && i.disabled).map((i) => (i as { id: string }).id);
    expect(disabled).toEqual(['row-up', 'column-move-left', 'align-left']);
  });

  it('adds, moves and deletes rows and columns, each as one undo step', () => {
    const view = editor(`x\n\n${TABLE}\n\ny`);
    const steps: Array<[number, number, string, string]> = [
      [1, 0, 'row-below', '| Name | Qty |\n|:-----|----:|\n| Tea  |   2 |\n|      |     |\n| Milk |  10 |'],
      [2, 0, 'row-up', '| Name | Qty |\n|:-----|----:|\n| Milk |  10 |\n| Tea  |   2 |'],
      [1, 0, 'row-delete', '| Name | Qty |\n|:-----|----:|\n| Milk |  10 |'],
      [0, 1, 'column-left', '| Name |     | Qty |\n|:-----|-----|----:|\n| Tea  |     |   2 |\n| Milk |     |  10 |'],
      [0, 0, 'column-move-right', '| Qty | Name |\n|----:|:-----|\n|   2 | Tea  |\n|  10 | Milk |'],
      [0, 1, 'column-delete', '| Name |\n|:-----|\n| Tea  |\n| Milk |'],
      [0, 1, 'align-center', '| Name | Qty |\n|:-----|:---:|\n| Tea  |   2 |\n| Milk |  10 |'],
    ];
    for (const [row, column, id, expected] of steps) {
      openMenu(view, row, column);
      run(view, id);
      expect(view.state.doc.toString()).toBe(`x\n\n${expected}\n\ny`);
      undo(view);
      expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}\n\ny`);
    }
  });

  it('deletes the whole table as one undo step', () => {
    const view = editor(`x\n\n${TABLE}\n\ny`);
    openMenu(view, 1, 1);
    run(view, 'table-delete');
    expect(view.state.doc.toString()).toBe('x\n\n\ny');
    undo(view);
    expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}\n\ny`);
  });

  it('keeps the cell being edited open where it moves', () => {
    const view = editor(TABLE);
    grid(view).activate(2, 0);
    openMenu(view, 2, 0);
    run(view, 'row-up');
    expect(grid(view).activeCell()).toMatchObject({ row: 1, column: 0 });
    expect(cellEditor(view).state.doc.toString()).toBe('Milk');
  });

  it('a row or column change under the open cell opens the cell that is there now (review)', () => {
    const cases: Array<[number, number, string, string, string]> = [
      // Deleting the open cell's row: the row below takes its place, and typing goes there.
      [1, 0, 'row-delete', 'Milk', '| Name  | Qty |\n|:------|----:|\n| MilkX |  10 |'],
      // Inserting a row above it: the new empty row is where the cell was.
      [1, 0, 'row-above', '', '| Name | Qty |\n|:-----|----:|\n| X    |     |\n| Tea  |   2 |\n| Milk |  10 |'],
    ];
    for (const [row, column, id, shownText, expected] of cases) {
      const view = editor(TABLE);
      grid(view).activate(row, column, 'end');
      openMenu(view, row, column);
      run(view, id);
      expect(cellEditor(view).state.doc.toString(), id).toBe(shownText);
      type(cellEditor(view), 'X');
      expect(view.state.doc.toString(), id).toBe(expected);
    }
  });

  it('a menu opened before another device changed the table does nothing (review)', () => {
    const view = editor(TABLE);
    openMenu(view, 2, 0);
    view.dispatch(remoteTransaction(view.state, TABLE.replace('| Tea  |   2 |', '| Jam  |   1 |\n| Tea  |   2 |'))!);
    run(view, 'row-delete');
    expect(view.state.doc.toString()).toBe(TABLE.replace('| Tea  |   2 |', '| Jam  |   1 |\n| Tea  |   2 |'));
  });

  it('a template or attachment inserted while a cell is open goes after the table (review)', () => {
    const view = editor(`Intro\n\n${TABLE}\n\nOutro`);
    grid(view).activate(1, 0);
    const table = view.state.doc.toString().indexOf(TABLE);
    const session = new DocumentSession('t.md', sessionDeps(fakeApi(new MockVault(false)).api));
    session.attach(view);
    expect(session.insertionRange()).toEqual({ from: table + TABLE.length, to: table + TABLE.length });
  });

  it('a cell at the edge of a row without outer pipes takes an edit that leaves blanks at its edge (review)', () => {
    const view = editor('a | b\n--|--\nx y | d\n\nafter');
    grid(view).activate(1, 0, 'start');
    const cell = cellEditor(view);
    cell.dispatch({ changes: { from: 0, to: 1 }, userEvent: 'delete.forward' });
    expect(view.state.doc.toString()).toBe('a | b\n--|--\ny | d\n\nafter');
  });

  it('moves a row by dragging its grip', () => {
    const view = editor(TABLE);
    const rows = [...view.dom.querySelectorAll<HTMLElement>('tr')];
    rows.forEach((tr, i) => {
      for (const cell of tr.querySelectorAll<HTMLElement>('.cm-lp-cell')) vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, i * 30, 100, 30));
    });
    const gripEl = view.dom.querySelector<HTMLElement>('.cm-lp-cell[data-row="2"] .cm-lp-grip-row')!;
    const pointer = (type: string, y: number) => gripEl.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 2, clientY: y, button: 0, pointerType: 'mouse' }));
    pointer('pointerdown', 75);
    pointer('pointermove', 50);
    pointer('pointermove', 35);
    pointer('pointerup', 35);
    expect(view.state.doc.toString()).toBe('| Name | Qty |\n|:-----|----:|\n| Milk |  10 |\n| Tea  |   2 |');
  });

  it('opens a row’s menu on a click of its grip', () => {
    const view = editor(TABLE);
    const gripEl = view.dom.querySelector<HTMLElement>('.cm-lp-cell[data-row="1"] .cm-lp-grip-row')!;
    gripEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    gripEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    expect(view.menus.at(-1)?.label).toBe('Row 1');
    expect(view.menus.at(-1)?.items.map((i) => (i === 'separator' ? '-' : i.id))).toEqual(['row-above', 'row-below', 'row-up', 'row-down', 'row-delete', '-', 'table-delete']);
  });

  it('opens the cell menu on a long-press', () => {
    vi.useFakeTimers();
    try {
      const view = editor(TABLE);
      const cell = view.dom.querySelector<HTMLElement>('td')!;
      cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 }));
      vi.advanceTimersByTime(600);
      expect(view.menus.at(-1)?.label).toBe('Row 1, column A');
      // The tap that ends the long-press does not open the cell.
      cell.click();
      expect(grid(view).activeCell()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('another device’s edit while a cell is being edited', () => {
  it('keeps editing the same cell when rows are added above it', () => {
    const view = editor(TABLE);
    grid(view).activate(2, 0, 'end');
    view.dispatch(remoteTransaction(view.state, TABLE.replace('| Tea  |   2 |\n', '| Tea  |   2 |\n| Jam  |   1 |\n'))!);
    expect(grid(view).activeCell()).toMatchObject({ row: 3, column: 0 });
    type(cellEditor(view), 'y');
    expect(view.state.doc.toString()).toBe('| Name  | Qty |\n|:------|----:|\n| Tea   |   2 |\n| Jam   |   1 |\n| Milky |  10 |');
  });

  it('shows another device’s change to the cell in its editor, keeping the caret', () => {
    const view = editor(TABLE);
    grid(view).activate(1, 0, 'end');
    const cell = cellEditor(view);
    view.dispatch(remoteTransaction(view.state, TABLE.replace('| Tea  |', '| Green Tea |').replace('|:-----|', '|:----------|'))!);
    expect(cellEditor(view)).toBe(cell);
    expect(cell.state.doc.toString()).toBe('Green Tea');
    expect(cell.state.selection.main.head).toBe('Green Tea'.length);
  });

  it('closes the cell when another device deletes its row', () => {
    const view = editor(TABLE);
    grid(view).activate(1, 0, 'end');
    view.dispatch(remoteTransaction(view.state, TABLE.replace('| Tea  |   2 |\n', ''))!);
    expect(grid(view).activeCell()).toBeNull();
    expect(shown(view)).toEqual([
      ['Name', 'Qty'],
      ['Milk', '10'],
    ]);
  });

  it('follows undo of the note while a cell is open', () => {
    const view = editor(`x‸\n\n${TABLE}`);
    view.dispatch({ changes: { from: 0, insert: 'y' }, userEvent: 'input.type' });
    grid(view).activate(1, 0, 'end');
    type(cellEditor(view), '!');
    undo(view);
    expect(view.state.doc.toString()).toBe(`yx\n\n${TABLE}`);
    expect(cellEditor(view).state.doc.toString()).toBe('Tea');
  });

  it('a remote change outside the table leaves the open cell alone', () => {
    const view = editor(`a\n\n${TABLE}`);
    grid(view).activate(1, 1, 'end');
    const cell = cellEditor(view);
    view.dispatch({ changes: { from: 0, insert: 'more text\n' }, annotations: [Transaction.remote.of(true)] });
    expect(cellEditor(view)).toBe(cell);
    type(cell, '5');
    expect(view.state.doc.toString()).toBe(`more text\na\n\n${TABLE.replace('|   2 |', '|  25 |')}`);
  });
});

describe('the note’s caret around a table', () => {
  it('never rests inside the table’s text', () => {
    const view = editor(`Before\n${TABLE}\n\nAfter`);
    const from = 'Before\n'.length;
    // A click goes to the nearer side; a move keeps going the way it went.
    view.dispatch({ selection: EditorSelection.cursor(from + 20), userEvent: 'select.pointer' });
    expect(view.state.selection.main.head).toBe(from - 1);
    view.dispatch({ selection: EditorSelection.cursor(from + 3), userEvent: 'select' });
    expect(view.state.selection.main.head).toBe(from + TABLE.length + 1);
    view.dispatch({ selection: EditorSelection.cursor(from + TABLE.length - 2), userEvent: 'select' });
    expect(view.state.selection.main.head).toBe(from - 1);
  });

  it('gets an empty line to rest on after a table that ends the note', () => {
    const view = editor(`x\n\n${TABLE}`);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), userEvent: 'select' });
    expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}\n`);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    const start = editor(`${TABLE}\n\nx‸`);
    start.dispatch({ selection: EditorSelection.cursor(0), userEvent: 'select' });
    expect(start.state.doc.toString()).toBe(`\n${TABLE}\n\nx`);
    expect(start.state.selection.main.head).toBe(0);
  });

  it('Escape from a table that ends the note makes a line after it', () => {
    const view = editor(`x\n\n${TABLE}`);
    grid(view).activate(2, 1);
    press(cellEditor(view), 'Escape');
    expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}\n`);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    type(view, 'y');
    expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}\n\ny`);
  });

  it('puts text typed right under a table on a line of its own', () => {
    const view = editor(`${TABLE}\n‸`);
    type(view, 'x');
    expect(view.state.doc.toString()).toBe(`${TABLE}\n\nx`);
    const end = editor(TABLE);
    end.dispatch({ selection: EditorSelection.cursor(TABLE.length) });
    type(end, 'y');
    expect(end.state.doc.toString()).toBe(`${TABLE}\n\ny`);
    expect(end.state.selection.main.head).toBe(end.state.doc.length);
  });

  it('never lets an edit make the line under a table one of its rows', () => {
    // The heading under a table turned into text.
    const heading = editor(`${TABLE}\n# Heading`);
    heading.dispatch({ changes: { from: TABLE.length + 1, to: TABLE.length + 3 }, userEvent: 'delete.backward' });
    expect(heading.state.doc.toString()).toBe(`${TABLE}\n\nHeading`);
    expect(tableBlocks(heading.state)[0].model.body).toHaveLength(2);
    // The blank line between a table and a paragraph deleted.
    const blank = editor(`${TABLE}\n\nnext`);
    blank.dispatch({ changes: { from: TABLE.length, to: TABLE.length + 1 }, userEvent: 'delete.selection' });
    expect(blank.state.doc.toString()).toBe(`${TABLE}\n\nnext`);
    // A list item under a table is no row: it stays where it is.
    const list = editor(`${TABLE}\n- item`);
    list.dispatch({ changes: { from: list.state.doc.length, insert: 's' }, userEvent: 'input.type' });
    expect(list.state.doc.toString()).toBe(`${TABLE}\n- items`);
    // Undo restores exactly what was there.
    undo(heading);
    expect(heading.state.doc.toString()).toBe(`${TABLE}\n# Heading`);
  });

  it('Backspace under a table goes into it instead of joining the line to it', () => {
    // A line of text right under a table is one of its rows, so only other blocks can follow it.
    for (const doc of [`${TABLE}\n‸# Heading`, `${TABLE}\n‸\nnext`]) {
      const view = editor(doc);
      press(view, 'Backspace');
      expect(view.state.doc.toString()).toBe(doc.replace('‸', ''));
      expect(grid(view).activeCell()).toMatchObject({ row: 2, column: 1 });
    }
    const last = editor(`${TABLE}\n‸`);
    press(last, 'Backspace');
    expect(last.state.doc.toString()).toBe(TABLE);
  });

  it('Backspace right after a table that ends the note goes into it, never deleting it', () => {
    for (const mods of [{}, { ctrlKey: true }, { altKey: true }]) {
      const view = editor(`x\n\n${TABLE}‸`);
      press(view, 'Backspace', mods);
      expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}`);
      expect(grid(view).activeCell()).toMatchObject({ row: 2, column: 1 });
    }
  });

  it('a caret left inside a table’s text (the note took the focus back) moves out of it', async () => {
    const view = editor(`x\n\n${TABLE}\n\ny`);
    grid(view).activate(1, 0);
    // The note's selection rests on the edited cell; the note's editor takes the focus.
    view.focus();
    // CodeMirror reports a focus change after 10 ms.
    await new Promise((done) => setTimeout(done, 30));
    expect(grid(view).activeCell()).toBeNull();
    const head = view.state.selection.main.head;
    expect(head < 3 || head > 3 + TABLE.length).toBe(true);
    // Deleting with a caret inside the table (however it got there) never eats the table.
    view.dispatch({ selection: EditorSelection.cursor(10), annotations: tableEdit.of(-1) });
    press(view, 'Backspace');
    press(view, 'Delete', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe(`x\n\n${TABLE}\n\ny`);
  });

  it('Delete at the end of the line before a table goes into it', () => {
    const view = editor(`text‸\n${TABLE}`);
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe(`text\n${TABLE}`);
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 0 });
  });
});

describe('inserting a table', () => {
  it('inserts an empty table on a blank line and opens its first cell', () => {
    const view = editor('Para\n‸\nMore');
    expect(insertTable(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Para\n\n|     |     |\n| --- | --- |\n|     |     |\n|     |     |\n\nMore');
    expect(grid(view).activeCell()).toMatchObject({ row: 0, column: 0 });
    type(cellEditor(view), 'Item');
    expect(view.state.doc.toString()).toBe('Para\n\n| Item |     |\n| ---- | --- |\n|      |     |\n|      |     |\n\nMore');
  });

  it('inserts after a line of text, apart from it', () => {
    const view = editor('Some text‸');
    insertTable(view);
    expect(view.state.doc.toString()).toBe('Some text\n\n|     |     |\n| --- | --- |\n|     |     |\n|     |     |');
  });

  it('inserts the text in source mode, with the caret in the first cell', () => {
    const view = editor('‸', { config: null });
    insertTable(view);
    expect(view.state.selection.main.head).toBe(2);
    expect(tableBlocks(view.state)).toHaveLength(0);
  });

  it('refuses inside a table cell', () => {
    const view = editor(TABLE);
    grid(view).activate(1, 0);
    const before = view.state.doc.toString();
    expect(insertTable(cellEditor(view))).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
  });
});
