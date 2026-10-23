// Typing formulas in a note's tables (DESIGN §6.42): pointing at cells, function suggestions and
// the signature hint, fill (Mod-D, Mod-R, the fill handle) and the friendlier #NAME?.
import { undo } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildVaultTree } from '../../api/vaultTree';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { formulaEngineForTests } from '../../formulas/load';
import { setActiveEditor } from '../activeEditor';
import type { NoteContext } from '../context';
import { noteExtensions } from '../editorSetup';
import { refreshTables } from './table';
import { gridOf, type TableGrid } from './table/grid';

const views: EditorView[] = [];

beforeAll(async () => {
  await formulaEngineForTests();
});

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  setActiveEditor(null);
  vi.restoreAllMocks();
  document.querySelectorAll('.formula-assist').forEach((el) => el.remove());
});

const tree = buildVaultTree({ eventId: 'b.1', folders: [], files: [] });

function context(): NoteContext {
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
    showMenu: () => {},
    renderEmbed: () => () => {},
    renderProperties: () => () => {},
  };
}

function editor(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: noteExtensions(context(), {
      onLocalChange: () => {},
      onBlur: () => {},
      readOnly: false,
      spellcheck: false,
      autocorrect: false,
      livePreview: { visibility: 'hide-all', locked: false, checkboxes: true },
    }),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  view.dispatch({ effects: refreshTables.of(null) });
  return view;
}

const grid = (view: EditorView, i = 0): TableGrid => gridOf(view.dom.querySelectorAll('.cm-lp-table')[i])!;
const cellEl = (view: EditorView, row: number, column: number, i = 0) => view.dom.querySelectorAll('.cm-lp-table')[i].querySelector<HTMLElement>(`.cm-lp-cell[data-row="${row}"][data-column="${column}"]`)!;

/** Opens a cell and types `text` into it (replacing what it holds), the caret at the end. */
function type(g: TableGrid, row: number, column: number, text: string): EditorView {
  g.activate(row, column, 'all');
  const cell = g.activeCell()!.editor;
  cell.dispatch(cell.state.replaceSelection(text), { userEvent: 'input.type' });
  return cell;
}

function press(el: HTMLElement, init: PointerEventInit): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init }));
}

function touchEnd(el: HTMLElement, x: number, y: number): Event {
  const e = new Event('touchend', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(e);
  return e;
}

const key = (view: EditorView, k: string, mods: KeyboardEventInit = {}) => runScopeHandlers(view, new KeyboardEvent('keydown', { key: k, ...mods }), 'editor');

const TABLE = '| Item | Cost |\n|---|---|\n| Rent | 1450 |\n| Food | 210 |\n| Web | 65 |\n| Total |  |';

describe('pointing at cells while a formula is typed', () => {
  it('a click on a cell puts its reference in, Shift-click makes a range, and the referenced cells are outlined', () => {
    const view = editor(`${TABLE}\n\nAfter`);
    const g = grid(view);
    const cell = type(g, 4, 1, '=SUM(');
    expect(cell.hasFocus).toBe(true);
    press(cellEl(view, 1, 1), { pointerType: 'mouse' });
    expect(cell.state.doc.toString()).toBe('=SUM(B2');
    // The click did not open the clicked cell.
    cellEl(view, 1, 1).click();
    expect(g.activeCell()).toMatchObject({ row: 4, column: 1 });
    press(cellEl(view, 3, 1), { pointerType: 'mouse', shiftKey: true });
    expect(cell.state.doc.toString()).toBe('=SUM(B2:B4');
    expect(view.state.doc.toString()).toContain('| =SUM(B2:B4 |');
    expect([1, 2, 3].map((r) => cellEl(view, r, 1).classList.contains('is-referenced'))).toEqual([true, true, true]);
    expect(cellEl(view, 1, 0).classList.contains('is-referenced')).toBe(false);
    // After a complete operand the click opens the cell, as before.
    cell.dispatch({ changes: { from: cell.state.doc.length, insert: ')' }, selection: { anchor: cell.state.doc.length + 1 } });
    press(cellEl(view, 1, 0), { pointerType: 'mouse' });
    cellEl(view, 1, 0).click();
    expect(g.activeCell()).toMatchObject({ row: 1, column: 0 });
  });

  it('a tap puts the reference in and keeps the keyboard up; a second tap makes a range; a scroll is not a tap', () => {
    const view = editor(`${TABLE}\n\nAfter`);
    const g = grid(view);
    const cell = type(g, 4, 1, '=AVERAGE(');
    press(cellEl(view, 1, 1), { pointerType: 'touch', clientX: 10, clientY: 10 });
    const end = touchEnd(cellEl(view, 1, 1), 11, 11);
    expect(end.defaultPrevented).toBe(true);
    expect(cell.state.doc.toString()).toBe('=AVERAGE(B2');
    expect(cell.hasFocus).toBe(true);
    press(cellEl(view, 2, 1), { pointerType: 'touch', clientX: 10, clientY: 40 });
    touchEnd(cellEl(view, 2, 1), 10, 40);
    expect(cell.state.doc.toString()).toBe('=AVERAGE(B2:B3');
    // A third tap starts again with its own cell.
    press(cellEl(view, 3, 1), { pointerType: 'touch', clientX: 10, clientY: 70 });
    touchEnd(cellEl(view, 3, 1), 10, 70);
    expect(cell.state.doc.toString()).toBe('=AVERAGE(B4');
    // A scroll that started on a cell puts nothing in.
    cell.dispatch({ changes: { from: cell.state.doc.length, insert: ',' }, selection: { anchor: cell.state.doc.length + 1 } });
    press(cellEl(view, 1, 1), { pointerType: 'touch', clientX: 10, clientY: 10 });
    touchEnd(cellEl(view, 1, 1), 10, 80);
    expect(cell.state.doc.toString()).toBe('=AVERAGE(B4,');
  });

  it('a cell of another table goes in with that table’s name', () => {
    const view = editor(`${TABLE}\n\n^budget\n\n| Year |\n|---|\n|  |\n\nAfter`);
    const year = grid(view, 1);
    const cell = type(year, 1, 0, '=');
    press(cellEl(view, 4, 1), { pointerType: 'mouse' });
    expect(cell.state.doc.toString()).toBe('=budget!B5');
    expect(cellEl(view, 4, 1).classList.contains('is-referenced')).toBe(true);
  });
});

describe('function suggestions and the signature hint', () => {
  it('typing =SU lists SUM first; Enter puts in SUM( and the hint shows its arguments', async () => {
    const view = editor(`${TABLE}\n\nAfter`);
    const cell = type(grid(view), 4, 1, '=SU');
    await vi.waitFor(() => expect(document.querySelector('.formula-assist-item')).not.toBeNull());
    const names = [...document.querySelectorAll('.formula-assist-item')].map((li) => li.textContent);
    expect(names[0]).toBe('SUM');
    expect(names).toContain('SUMIF');
    expect(key(cell, 'Enter')).toBe(true);
    expect(cell.state.doc.toString()).toBe('=SUM(');
    // Still the same cell: Enter went to the list, not to the cell below.
    expect(grid(view).activeCell()).toMatchObject({ row: 4, column: 1 });
    const hint = document.querySelector<HTMLElement>('.formula-assist-hint')!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('SUM(value1, [value2, …])');
    expect(hint.querySelector('b')?.textContent).toBe('value1');
    cell.dispatch({ changes: { from: cell.state.doc.length, insert: 'B2, ' }, selection: { anchor: cell.state.doc.length + 4 } });
    expect(hint.querySelector('b')?.textContent).toBe('[value2, …]');
  });

  it('ArrowDown chooses another suggestion and a tap on one keeps the focus', async () => {
    const view = editor(`${TABLE}\n\nAfter`);
    const cell = type(grid(view), 4, 1, '=COUNTI');
    await vi.waitFor(() => expect(document.querySelectorAll('.formula-assist-item').length).toBeGreaterThan(1));
    expect(key(cell, 'ArrowDown')).toBe(true);
    const chosen = document.querySelector('.formula-assist-item[aria-selected="true"]')!;
    const item = chosen as HTMLElement;
    const end = touchEnd(item, 0, 0);
    expect(end.defaultPrevented).toBe(true);
    expect(cell.state.doc.toString()).toBe(`=${item.textContent}(`);
    expect(cell.hasFocus).toBe(true);
  });
});

describe('fill in tables', () => {
  const NUMBERS = '| A | B |\n|---|---|\n| 1 | =A2*2 |\n| 2 |  |\n|  |  |\n|  |  |';

  it('Mod-D fills the cell from the one above, shifting relative references', () => {
    const view = editor(`${NUMBERS}\n\nAfter`);
    const g = grid(view);
    g.activate(2, 1, 'end');
    const cell = g.activeCell()!.editor;
    expect(key(cell, 'd', { ctrlKey: true })).toBe(true);
    expect(cell.state.doc.toString()).toBe('=A3*2');
    expect(view.state.doc.toString()).toContain('| 2 | =A3*2 |');
  });

  it('Mod-R fills right; a Shift-selected range fills from its first row, keeping absolute references', () => {
    const view = editor('| A | B | C |\n|---|---|---|\n| 3 | =$A$2+A2 |  |\n| 4 |  |  |\n\nAfter');
    const g = grid(view);
    g.activate(1, 2, 'end');
    expect(key(g.activeCell()!.editor, 'r', { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toContain('| 3 | =$A$2+A2 | =$A$2+B2 |');
    g.activate(1, 1, 'end');
    cellEl(view, 2, 1).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    expect(cellEl(view, 2, 1).classList.contains('is-selected')).toBe(true);
    expect(key(g.activeCell()!.editor, 'd', { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toContain('| 4 | =$A$2+A3 |');
  });

  it('dragging the fill handle down copies formulas and continues a number series, as one undo step', () => {
    const view = editor(`${NUMBERS}\n\nAfter`);
    const g = grid(view);
    g.activate(1, 0, 'end');
    // Shift-click selects A2:B3 (two numbers and a formula).
    cellEl(view, 2, 1).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    const handle = view.dom.querySelector<HTMLElement>('.cm-lp-fill-handle')!;
    expect(handle.hidden).toBe(false);
    const target = cellEl(view, 4, 1);
    // jsdom has no layout: the pointer is over B5.
    Object.defineProperty(document, 'elementFromPoint', { value: () => target, configurable: true });
    const pointer = (type: string) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', clientX: 5, clientY: 5 }));
    pointer('pointerdown');
    pointer('pointermove');
    expect(cellEl(view, 3, 0).classList.contains('is-fill-target')).toBe(true);
    pointer('pointerup');
    const text = view.state.doc.toString();
    expect(text).toContain('| 3 | =A4*2 |');
    // B3 was empty: its copy in B5 is empty too.
    expect(text).toMatch(/\| 4 \| +\|/);
    undo(view);
    expect(view.state.doc.toString()).toBe(`${NUMBERS}

After`);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });
});

describe('a friendlier #NAME?', () => {
  it('a function name without its brackets asks whether the call was meant', () => {
    const view = editor(`${TABLE}\n\nAfter`);
    type(grid(view), 4, 1, '=SUM');
    const bar = view.dom.querySelector<HTMLElement>('.cm-lp-formula-bar')!;
    return vi.waitFor(() => {
      expect(bar.textContent).toContain('#NAME?');
      expect(bar.querySelector('.cm-lp-formula-bar-hint')?.textContent).toBe('Did you mean SUM(…)?');
    });
  });
});
