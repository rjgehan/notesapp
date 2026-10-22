import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildVaultTree } from '../../api/vaultTree';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { formulaEngineForTests } from '../../formulas/load';
import { setActiveEditor } from '../activeEditor';
import type { NoteContext } from '../context';
import { noteExtensions } from '../editorSetup';
import { formulaField, formulaResults } from './formulas';
import { gridOf } from './table/grid';
import { refreshTables } from './table';

const views: EditorView[] = [];

beforeAll(async () => {
  await formulaEngineForTests();
});

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  setActiveEditor(null);
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
    toggleMode: () => {},
    insertFiles: () => {},
    linkTo: (p) => `[[${p}]]`,
    showMenu: () => {},
    renderEmbed: () => () => {},
    renderProperties: () => () => {},
  };
}

function editor(doc: string, { locked = false, cursor = doc.length } = {}): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: noteExtensions(context(), {
      onLocalChange: () => {},
      onBlur: () => {},
      readOnly: false,
      spellcheck: false,
      autocorrect: false,
      livePreview: { visibility: 'hide-all', locked, checkboxes: !locked },
    }),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  view.dispatch({ effects: refreshTables.of(null) });
  return view;
}

function cells(view: EditorView, i = 0): string[][] {
  const table = view.dom.querySelectorAll('.cm-lp-table')[i];
  return [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('.cm-lp-cell-content')].map((c) => c.textContent ?? ''));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const BUDGET = '| Item | Cost |\n|---|---|\n| Rent | 1450 |\n| Utilities | 210 |\n| Internet | 65 |\n| **Total** | =SUM(B2:B4) |';

describe('formulas in Live Preview (ROADMAP 39)', () => {
  it('shows a formula cell’s result; the file keeps the formula', () => {
    const view = editor(`${BUDGET}\n\nAfter`);
    expect(cells(view)[4]).toEqual(['Total', '1725']);
    expect(view.state.doc.toString()).toContain('=SUM(B2:B4)');
    const value = view.dom.querySelector('.cm-formula-value') as HTMLElement;
    expect(value.title).toBe('=SUM(B2:B4)');
  });

  it('shows the formula while the cell is edited, with the formula bar, and recalculates as you type', async () => {
    const view = editor(`${BUDGET}\n\nAfter`);
    const grid = gridOf(view.dom.querySelector('.cm-lp-table'))!;
    grid.activate(4, 1, 'end');
    const cell = grid.activeCell()!.editor;
    expect(cell.state.doc.toString()).toBe('=SUM(B2:B4)');
    const bar = view.dom.querySelector('.cm-lp-formula-bar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toBe('B51725');
    cell.dispatch({ changes: { from: cell.state.doc.length, insert: '*2' }, userEvent: 'input.type' });
    await settle();
    expect(view.state.doc.toString()).toContain('=SUM(B2:B4)*2');
    expect(bar.textContent).toBe('B53450');
    grid.deactivate();
    expect(bar.hidden).toBe(true);
    expect(cells(view)[4][1]).toBe('3450');
  });

  it('recalculates a formula when a cell it reads changes', async () => {
    const view = editor(`${BUDGET}\n\nAfter`);
    const grid = gridOf(view.dom.querySelector('.cm-lp-table'))!;
    grid.activate(1, 1, 'all');
    const cell = grid.activeCell()!.editor;
    cell.dispatch(cell.state.replaceSelection('2000'), { userEvent: 'input.type' });
    await settle();
    expect(cells(view)[4][1]).toBe('2275');
  });

  it('updates a table that reads another table when that one changes (39b)', async () => {
    const doc = `${BUDGET}\n\n^budget\n\n| Year |\n|---|\n| =budget!B5*12 |\n\nAfter`;
    const view = editor(doc);
    expect(cells(view, 1)[1]).toEqual(['20,700']);
    const at = view.state.doc.toString().indexOf('1450');
    view.dispatch({ changes: { from: at, to: at + 4, insert: '1550' } });
    await vi.waitFor(() => expect(cells(view, 1)[1]).toEqual(['21,900']));
  });

  it('shows inline formulas’ results, and the code while the caret is on them', () => {
    const doc = `${BUDGET}\n\n^budget\n\nA year: \`=budget!B5*12\`, a month: \`=1450\`.\n\nEnd`;
    const view = editor(doc);
    const inline = [...view.dom.querySelectorAll('.cm-formula-inline')].map((e) => e.textContent);
    expect(inline).toEqual(['20,700', '1450']);
    const at = doc.indexOf('`=1450`') + 2;
    view.dispatch({ selection: EditorSelection.cursor(at) });
    expect([...view.dom.querySelectorAll('.cm-formula-inline')].map((e) => e.textContent)).toEqual(['20,700']);
  });

  it('always shows results in a locked note, and errors inline with their message', () => {
    const doc = 'Total: `=1/0` and `=2+2` here\n\n| a |\n|---|\n| =A1+1 |';
    const view = editor(doc, { locked: true, cursor: 9 });
    const inline = [...view.dom.querySelectorAll('.cm-formula-inline')];
    expect(inline.map((e) => e.textContent)).toEqual(['#DIV/0!', '4']);
    expect(inline[0].classList.contains('cm-formula-error')).toBe(true);
    expect((inline[0] as HTMLElement).title).toContain('Division by zero');
    // `a` is text: text plus one is #VALUE!.
    expect(cells(view)[1]).toEqual(['#VALUE!']);
  });

  it('turns formulas off with formulas: false', () => {
    const view = editor(`---\nformulas: false\n---\n${BUDGET}\n\nInline \`=1+1\`.`);
    expect(cells(view)[4][1]).toBe('=SUM(B2:B4)');
    expect(view.dom.querySelector('.cm-formula-inline')).toBeNull();
    expect(formulaResults(view.state)).toBeNull();
  });

  it('applies column formats from the formats line (39b) and leaves highlights alone', () => {
    const doc = '| Item | Cost | Share |\n|---|---|---|\n| Rent | 1450 | 0.25 |\n| ==x== | 3 | 1 |\n\n%% formats: B=currency C=percent %%\n\nEnd';
    const view = editor(doc);
    expect(cells(view)[1]).toEqual(['Rent', '$1,450.00', '25.00%']);
    expect(cells(view)[2]).toEqual(['x', '$3.00', '100.00%']);
  });

  it('reuses the tables an edit did not touch, and keeps results for a same version', () => {
    const view = editor(`${BUDGET}\n\nText here`);
    const before = view.state.field(formulaField);
    const results = formulaResults(view.state);
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' more' } });
    const after = view.state.field(formulaField);
    expect(after.version).toBe(before.version);
    expect(after.entries[0].rows).toBe(before.entries[0].rows);
    expect(formulaResults(view.state)).toBe(results);
  });
});
