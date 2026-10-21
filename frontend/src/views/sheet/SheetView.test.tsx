// The spreadsheet view with the real session, engine and binding over the mock vault, and Glide
// Data Grid replaced by a stand-in (jsdom has no canvas): the test calls the grid's callbacks the
// way Glide would and checks the file the session saves.
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { httpEndpoints, installEndpoints } from '../../api/endpoints';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import type { FileEntry } from '../../api/types';
import { Dialogs } from '../../components/overlays/Dialogs';
import { Toasts } from '../../components/overlays/Toasts';
import { runCommand } from '../../features/commands';
import { activeSheet } from '../../sheets/activeSheet';
import { parseSheet, type SheetFile } from '../../sheets/format';
import { useToasts } from '../../state/toasts';
import { documents } from '../../sync/instance';
import { fakeApi } from '../../test/fakes';
import { fakeGrid, gridProps } from '../../test/fakeGrid';
import { SHEET_COMMANDS } from './register';
import SheetView from './SheetView';
import { clearSheetBindings } from './useSheetDocument';

vi.mock('@glideapps/glide-data-grid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@glideapps/glide-data-grid')>();
  const { FakeDataEditor } = await import('../../test/fakeGrid');
  return { ...actual, DataEditor: FakeDataEditor };
});

const BUDGET = {
  type: 'notesapp-sheet',
  version: 1,
  engine: 'hyperformula@3.4.0',
  sheets: [
    {
      id: 's1',
      name: 'Budget',
      cells: {
        A1: { v: 'Item' },
        B1: { v: 'Cost' },
        A2: { v: 'Rent' },
        B2: { v: 1450 },
        A3: { v: 'Food' },
        B3: { v: 487.5 },
        B5: { f: '=SUM(B2:B4)', c: 1937.5 },
        C2: { f: '=B2/Total', c: 0.748 },
      },
      cols: { A: { w: 180 } },
      rows: { '1': { bold: true } },
      frozen: { rows: 1, cols: 0 },
    },
    { id: 's2', name: 'Notes', cells: { A1: { v: 'n' } } },
  ],
  named: { Total: 'Budget!$B$5' },
};

const vault = new MockVault(false);
let count = 0;

beforeAll(() => {
  const fake = fakeApi(vault);
  installEndpoints({
    ...httpEndpoints,
    readFile: fake.api.readFile,
    saveFile: fake.api.saveFile,
    createFile: async (req, opts) => structuredClone(vault.createFile(req, 'me-0000001', opts?.idempotencyKey)),
  });
});

afterEach(() => {
  for (const s of documents.all()) documents.close(s);
  clearSheetBindings();
  fakeGrid.props = null;
  queryClient.clear();
  useToasts.setState({ toasts: [] });
});

function entry(path: string): FileEntry {
  const f = vault.readFile(path);
  return { path, name: path, basename: path.replace(/\.sheet$/, ''), extension: 'sheet', kind: 'text', size: f.content.length, mtime: '2026-10-17T10:00:00.000Z', version: f.version, aliases: [] };
}

/** A new file per test (sessions are cached by path for the page's lifetime). */
async function open(content: unknown = BUDGET, hash = '') {
  const path = `Sheet ${++count}.sheet`;
  vault.createFile({ path, content: typeof content === 'string' ? content : JSON.stringify(content) }, 'other-device-1');
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/n/${path}${hash}`]}>
        <SheetView path={path} entry={entry(path)} mode="edit" />
        <Dialogs />
        <Toasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return path;
}

async function openGrid(content: unknown = BUDGET, hash = '') {
  const path = await open(content, hash);
  await screen.findByTestId('grid', {}, { timeout: 5000 });
  return path;
}

const session = (path: string) => documents.get(path)!;

/** The file as saved, after flushing the session. */
async function saved(path: string): Promise<SheetFile> {
  await act(async () => {
    await session(path).flush();
  });
  const parsed = parseSheet(vault.readFile(path).content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.file;
}

const nameBox = () => screen.getByLabelText('Cell reference') as HTMLInputElement;
const formulaInput = () => screen.getByLabelText(/^Contents of/) as HTMLInputElement;
/** A press on the grid's rows selecting a range, as Glide reports it. */
function select(col: number, gridRow: number, width = 1, height = 1) {
  fireEvent.pointerDown(screen.getByTestId('grid'), { clientY: 500, pointerType: 'mouse' });
  act(() =>
    gridProps().onGridSelectionChange!({
      current: { cell: [col, gridRow], range: { x: col, y: gridRow, width, height }, rangeStack: [] },
      columns: gridProps().gridSelection!.columns,
      rows: gridProps().gridSelection!.rows,
    }),
  );
}

describe('the spreadsheet view', () => {
  it('shows the sheet: values, letters, widths, frozen rows in the header, row numbers after them', async () => {
    await openGrid();
    const p = gridProps();
    // Row 1 is frozen: grid row 0 is sheet row 2.
    expect(screen.getByTestId('cell-A0')).toHaveTextContent('Rent');
    expect(screen.getByTestId('cell-B3')).toHaveTextContent('1937.5');
    expect(p.columns.slice(0, 2).map((c) => [c.title, 'width' in c ? c.width : null])).toEqual([
      ['A', 180],
      ['B', 100],
    ]);
    expect(p.rowMarkers).toMatchObject({ kind: 'clickable-number', startIndex: 2 });
    expect(p.headerHeight).toBe(26 + 24);
    expect(p.getRowThemeOverride!(0, 0, 0)).toBeUndefined();
    // The frozen row is drawn in the header under the letters.
    const texts: string[] = [];
    const ctx = new Proxy(
      { fillText: (t: string) => texts.push(t) },
      { get: (target, key) => (key in target ? target[key as 'fillText'] : () => {}), set: () => true },
    ) as unknown as CanvasRenderingContext2D;
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    const args = { ctx, rect, isSelected: false, hasSelectedCell: false, isHovered: false, hoverAmount: 0, theme: {}, column: p.columns[0], menuBounds: rect, spriteManager: {}, hoverX: undefined, hoverY: undefined };
    p.drawHeader!({ ...args, columnIndex: 0 } as never, () => {});
    p.drawHeader!({ ...args, columnIndex: -1 } as never, () => {});
    expect(texts).toEqual(['A', 'Item', '1']);
    expect(screen.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true');
  });

  it('edits a cell in the formula bar: Enter commits, moves down and saves', async () => {
    const path = await openGrid();
    expect(nameBox().value).toBe('A1');
    expect(formulaInput().value).toBe('Item');
    select(1, 0);
    expect(nameBox().value).toBe('B2');
    expect(formulaInput().value).toBe('1450');
    fireEvent.focus(formulaInput());
    fireEvent.change(formulaInput(), { target: { value: '=B3*2' } });
    fireEvent.keyDown(formulaInput(), { key: 'Enter' });
    expect(nameBox().value).toBe('B3');
    expect(screen.getByTestId('cell-B0')).toHaveTextContent('975');
    const file = await saved(path);
    expect(file.sheets[0].cells.B2).toEqual({ f: '=B3*2', c: 975 });
    expect(file.sheets[0].cells.B5.c).toBe(1462.5);
  });

  it("commits Glide's cell editor, clears with Delete, and undoes with Mod-Z", async () => {
    const path = await openGrid();
    act(() => gridProps().onCellEdited!([3, 0], { kind: 'text', data: '42', displayData: '', allowOverlay: true } as never));
    expect((await saved(path)).sheets[0].cells.D2).toEqual({ v: 42 });
    select(0, 0, 2, 2);
    act(() => void gridProps().onDelete!(gridProps().gridSelection!));
    expect(screen.getByTestId('cell-A0')).toHaveTextContent('');
    expect((await saved(path)).sheets[0].cells.A2).toBeUndefined();
    const key = (k: string, shift = false) => {
      const e = { key: k, ctrlKey: true, metaKey: false, shiftKey: shift, altKey: false, cancel: vi.fn(), preventDefault: vi.fn(), stopPropagation: vi.fn(), bounds: undefined, keyCode: 0, rawEvent: undefined, location: undefined };
      act(() => gridProps().onKeyDown!(e));
      return e;
    };
    expect(key('z').cancel).toHaveBeenCalled();
    expect(screen.getByTestId('cell-A0')).toHaveTextContent('Rent');
    key('z', true);
    expect(screen.getByTestId('cell-A0')).toHaveTextContent('');
  });

  it("opens Glide's editor with F2 on desktop, so the key never reaches Rename file", async () => {
    await openGrid();
    // Glide activates a cell on the keys it is given; F2 is one of them, and a matched key goes no further.
    expect(String(gridProps().keybindings?.activateCell).split('|')).toEqual([' ', 'Enter', 'shift+Enter', 'F2']);
    select(1, 1);
    const e = { key: 'F2', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, cancel: vi.fn(), preventDefault: vi.fn(), stopPropagation: vi.fn(), bounds: undefined, keyCode: 113, rawEvent: undefined, location: undefined };
    act(() => gridProps().onKeyDown!(e));
    // The view leaves it to Glide (it edits frozen cells and touch devices in the formula bar itself).
    expect(e.cancel).not.toHaveBeenCalled();
  });

  it('fills down with Mod-D and with the fill handle, shifting formulas', async () => {
    const path = await openGrid();
    // C2 (grid row 0) down to C3.
    select(2, 0, 1, 2);
    act(() => gridProps().onKeyDown!({ key: 'd', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, cancel: () => {}, preventDefault: () => {}, stopPropagation: () => {}, bounds: undefined, keyCode: 68, rawEvent: undefined, location: undefined }));
    expect((await saved(path)).sheets[0].cells.C3.f).toBe('=B3/Total');
    const prevent = vi.fn();
    act(() => gridProps().onFillPattern!({ patternSource: { x: 1, y: 0, width: 1, height: 1 }, fillDestination: { x: 1, y: 0, width: 2, height: 1 }, preventDefault: prevent }));
    expect(prevent).toHaveBeenCalled();
    expect((await saved(path)).sheets[0].cells.C2).toEqual({ v: 1450 });
  });

  it('copies values as TSV and pastes its own copy with formulas shifted', async () => {
    const path = await openGrid();
    select(1, 0, 2, 1); // B2:C2
    screen.getByTestId('grid').focus();
    const data = new Map<string, string>();
    const clipboardData = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '' };
    const copy = new Event('copy', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copy, 'clipboardData', { value: clipboardData });
    act(() => void window.dispatchEvent(copy));
    expect(copy.defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe('1450\t0.7483870968');
    select(1, 5); // B7
    const paste = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData });
    act(() => void window.dispatchEvent(paste));
    const cells = (await saved(path)).sheets[0].cells;
    expect(cells.B7).toEqual({ v: 1450 });
    expect(cells.C7.f).toBe('=B7/Total');
    expect(nameBox().value).toBe('B7:C7');
    // Text from another program is typed input.
    data.set('text/plain', 'x\t=1+1\n3');
    const other = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(other, 'clipboardData', { value: clipboardData });
    select(4, 0);
    act(() => void window.dispatchEvent(other));
    const after = (await saved(path)).sheets[0].cells;
    expect([after.E2, after.F2.f, after.E3]).toEqual([{ v: 'x' }, '=1+1', { v: 3 }]);
  });

  it('moves cut cells on paste: formulas and named ranges follow, one undo step', async () => {
    const path = await openGrid();
    const data = new Map<string, string>();
    const clipboardData = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '' };
    const fire = (type: 'cut' | 'paste') => {
      const e = new Event(type, { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(e, 'clipboardData', { value: clipboardData });
      act(() => void window.dispatchEvent(e));
      return e;
    };
    select(1, 3); // B5, =SUM(B2:B4), which the named range Total points at
    screen.getByTestId('grid').focus();
    expect(fire('cut').defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe('1937.5');
    // Nothing moves until the paste; the cut cells are outlined meanwhile.
    expect((await saved(path)).sheets[0].cells.B5).toEqual({ f: '=SUM(B2:B4)', c: 1937.5 });
    expect(gridProps().highlightRegions).toEqual([expect.objectContaining({ style: 'dashed', range: { x: 1, y: 3, width: 1, height: 1 } })]);
    select(3, 5); // D7
    fire('paste');
    expect(gridProps().highlightRegions).toBeUndefined();
    let file = await saved(path);
    expect(file.sheets[0].cells.B5).toBeUndefined();
    expect(file.sheets[0].cells.D7).toEqual({ f: '=SUM(B2:B4)', c: 1937.5 });
    expect(file.named.Total).toBe('Budget!$D$7');
    expect(file.sheets[0].cells.C2.c).toBeCloseTo(0.748, 3);
    expect(nameBox().value).toBe('D7');
    // A second paste copies the moved cell from its new place.
    select(4, 5); // E7
    fire('paste');
    expect((await saved(path)).sheets[0].cells.E7).toEqual({ f: '=SUM(C2:C4)', c: expect.any(Number) });
    const undo = () => act(() => gridProps().onKeyDown!({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, cancel: vi.fn(), preventDefault: vi.fn(), stopPropagation: vi.fn(), bounds: undefined, keyCode: 90, rawEvent: undefined, location: undefined }));
    undo();
    undo();
    file = await saved(path);
    expect(file.sheets[0].cells.B5).toEqual({ f: '=SUM(B2:B4)', c: 1937.5 });
    expect(file.named.Total).toBe('Budget!$B$5');
  });

  it('pastes a cut as a copy when the cut cells changed meanwhile, and Escape drops the cut', async () => {
    const path = await openGrid();
    const data = new Map<string, string>();
    const clipboardData = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '' };
    const fire = (type: 'cut' | 'paste') => {
      const e = new Event(type, { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(e, 'clipboardData', { value: clipboardData });
      act(() => void window.dispatchEvent(e));
    };
    select(1, 0); // B2
    screen.getByTestId('grid').focus();
    fire('cut');
    act(() => gridProps().onCellEdited!([1, 0], { kind: 'text', data: '1', displayData: '', allowOverlay: true } as never));
    select(3, 0); // D2
    fire('paste');
    const cells = (await saved(path)).sheets[0].cells;
    expect(cells.B2).toEqual({ v: 1 });
    expect(cells.D2).toEqual({ v: 1450 });
    // Escape in the grid drops a pending cut's outline.
    select(1, 1);
    fire('cut');
    expect(gridProps().highlightRegions).toHaveLength(1);
    act(() => gridProps().onKeyDown!({ key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, cancel: vi.fn(), preventDefault: vi.fn(), stopPropagation: vi.fn(), bounds: undefined, keyCode: 27, rawEvent: undefined, location: undefined }));
    expect(gridProps().highlightRegions).toBeUndefined();
  });

  it('selects, edits and leaves frozen cells', async () => {
    const path = await openGrid();
    select(0, 2);
    const header = (col: number, y: number, extra = {}) =>
      act(() => gridProps().onHeaderClicked!(col, { localEventY: y, localEventX: 5, isTouch: false, preventDefault: vi.fn(), ...extra } as never));
    // A press on the frozen band does not select the column.
    const before = screen.getByLabelText('Cell reference');
    header(1, 30);
    expect(nameBox().value).toBe('B1');
    expect(before).toBe(nameBox());
    header(1, 30);
    expect(document.activeElement).toBe(formulaInput());
    fireEvent.change(formulaInput(), { target: { value: 'Cost (USD)' } });
    fireEvent.keyDown(formulaInput(), { key: 'Enter' });
    expect((await saved(path)).sheets[0].cells.B1).toEqual({ v: 'Cost (USD)' });
    expect(nameBox().value).toBe('B2');
    // Up from the first grid row goes into the frozen row; typing there edits in the bar.
    act(() => gridProps().onKeyDown!({ key: 'ArrowUp', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, cancel: () => {}, preventDefault: () => {}, stopPropagation: () => {}, bounds: undefined, keyCode: 38, rawEvent: undefined, location: undefined }));
    expect(nameBox().value).toBe('B1');
    act(() => gridProps().onKeyDown!({ key: 'Q', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, cancel: () => {}, preventDefault: () => {}, stopPropagation: () => {}, bounds: undefined, keyCode: 81, rawEvent: undefined, location: undefined }));
    expect(document.activeElement).toBe(formulaInput());
    expect(formulaInput().value).toBe('Q');
    fireEvent.keyDown(formulaInput(), { key: 'Escape' });
    expect(formulaInput().value).toBe('Cost (USD)');
    // Glide selecting on its own (focus without a selection) does not leave the frozen cell.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    act(() => gridProps().onGridSelectionChange!({ current: { cell: [0, 0], range: { x: 0, y: 0, width: 1, height: 1 }, rangeStack: [] }, columns: gridProps().gridSelection!.columns, rows: gridProps().gridSelection!.rows }));
    expect(nameBox().value).toBe('B1');
  });

  it('resizes columns, freezes, bolds rows, and goes to a named range', async () => {
    const path = await openGrid();
    act(() => gridProps().onColumnResizeEnd!(gridProps().columns[1], 151.4, 1, 151.4));
    expect((await saved(path)).sheets[0].cols.B).toEqual({ w: 151 });
    select(1, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Bold rows' }));
    expect((await saved(path)).sheets[0].rows['3']).toEqual({ bold: true });
    fireEvent.click(screen.getByRole('button', { name: 'Freeze rows or columns' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Freeze columns A–B' }));
    expect((await saved(path)).sheets[0].frozen).toEqual({ rows: 1, cols: 2 });
    expect(gridProps().freezeColumns).toBe(2);
    fireEvent.change(nameBox(), { target: { value: 'total' } });
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(nameBox().value).toBe('B5');
    fireEvent.change(nameBox(), { target: { value: 'Notes!A1' } });
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(nameBox(), { target: { value: 'nowhere' } });
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(nameBox()).toHaveAttribute('aria-invalid', 'true');
  });

  it('sets a column width from the dialog (the way on a phone)', async () => {
    const path = await openGrid();
    select(1, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Column width' }));
    const dialog = screen.getByRole('dialog', { name: 'Width of column B' });
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '222' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect((await saved(path)).sheets[0].cols.B).toEqual({ w: 222 });
    fireEvent.click(screen.getByRole('button', { name: 'Column width' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }));
    expect((await saved(path)).sheets[0].cols.B).toBeUndefined();
  });

  it('adds, renames, reorders and deletes sheets', async () => {
    const path = await openGrid();
    fireEvent.click(screen.getByRole('button', { name: 'Add sheet' }));
    expect(screen.getByRole('tab', { name: 'Sheet3' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Sheet3' }));
    const input = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'notes' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/already a sheet/);
    fireEvent.change(input, { target: { value: 'Summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await screen.findByRole('tab', { name: 'Summary' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for sheet Summary' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Budget', 'Summary', 'Notes']);
    expect((await saved(path)).sheets.map((s) => s.name)).toEqual(['Budget', 'Summary', 'Notes']);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for sheet Summary' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Budget', 'Notes']));
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('defines named ranges in the dialog', async () => {
    const path = await openGrid();
    select(1, 0, 1, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Named ranges' }));
    const dialog = screen.getByRole('dialog', { name: 'Named ranges' });
    expect(within(dialog).getByLabelText('Range of Total')).toHaveValue('Budget!$B$5');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Costs' } });
    expect(within(dialog).getByLabelText('Range or value')).toHaveValue('Budget!$B$2:$B$3');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect((await saved(path)).named).toEqual({ Costs: 'Budget!$B$2:$B$3', Total: 'Budget!$B$5' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Bad' } });
    fireEvent.change(within(dialog).getByLabelText('Range or value'), { target: { value: 'SUM(' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/not a range/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Costs' }));
    expect((await saved(path)).named).toEqual({ Total: 'Budget!$B$5' });
  });

  it("shows another device's change and runs palette commands on the open sheet", async () => {
    const path = await openGrid();
    const next = JSON.parse(JSON.stringify(BUDGET)) as typeof BUDGET;
    next.sheets[0].cells.A2 = { v: 'Mortgage' };
    vault.externalWrite(path, JSON.stringify(next));
    await act(async () => {
      await session(path).onRemoteChanged({ version: vault.readFile(path).version });
    });
    expect(screen.getByTestId('cell-A0')).toHaveTextContent('Mortgage');
    expect(await screen.findByText('Updated from another device')).toBeInTheDocument();
    // Palette commands reach the mounted view.
    expect(activeSheet(path)).not.toBeNull();
    expect(SHEET_COMMANDS.find((c) => c.id === 'sheet.addSheet')!.when!({ activePath: path })).toBe(true);
    expect(SHEET_COMMANDS.find((c) => c.id === 'sheet.addSheet')!.when!({ activePath: 'other.sheet' })).toBe(false);
    act(() => void SHEET_COMMANDS.find((c) => c.id === 'sheet.addSheet')!.run({ activePath: path }));
    expect(screen.getByRole('tab', { name: 'Sheet3' })).toBeInTheDocument();
    expect(runCommand).toBeDefined();
  });

  it('shows a file a newer NotesApp wrote read-only, without inviting a fix', async () => {
    const text = '{"type": "notesapp-sheet", "version": 2, "sheets": []}';
    const path = await open(text);
    expect(await screen.findByText(/read-only here/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/saved by a newer NotesApp/)).toBeInTheDocument();
    expect(screen.queryByText(/Fix it as text/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open as spreadsheet' })).toBeNull();
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull());
    expect(document.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'false');
    expect(vault.readFile(path).content).toBe(text);
  });

  it('opens a file it cannot read as text, untouched, and as a sheet once fixed', async () => {
    const text = '{"type": "notesapp-sheet", "version": 1, "sheets": [], "sheets": []}';
    const path = await open(text);
    expect(await screen.findByText(/cannot be shown as a spreadsheet/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/appears twice/)).toBeInTheDocument();
    expect(screen.getByText(/Fix it as text/)).toBeInTheDocument();
    // Nothing was written: the file is as it was.
    expect(vault.readFile(path).content).toBe(text);
    act(() => session(path).applyEdit({ from: 0, to: session(path).editorState.doc.length, insert: JSON.stringify(BUDGET) }));
    fireEvent.click(screen.getByRole('button', { name: 'Open as spreadsheet' }));
    expect(await screen.findByTestId('grid')).toBeInTheDocument();
  });

  it('is read-only for a file that is not valid UTF-8', async () => {
    const path = `Lossy ${++count}.sheet`;
    const json = new TextEncoder().encode(JSON.stringify(BUDGET).replace('Rent', 'R__t'));
    const at = json.indexOf(95);
    json[at] = 0xff;
    json[at + 1] = 0xfe;
    await vault.uploadRaw(path, new Blob([json]), 'fail', 'other-device-1');
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SheetView path={path} entry={entry(path)} mode="edit" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('grid', {}, { timeout: 5000 });
    expect(gridProps().getCellContent([0, 0])).toMatchObject({ readonly: true, allowOverlay: false });
    expect(formulaInput()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Bold rows' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add sheet' })).toBeNull();
    expect(gridProps().onColumnResizeEnd).toBeUndefined();
  });
  it('on a touch device edits in the formula bar: a tap on the selected cell focuses it in the touchend', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({ matches: query === '(pointer: coarse)', media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList,
    );
    const path = await openGrid();
    expect(gridProps().getCellContent([0, 0])).toMatchObject({ allowOverlay: false });
    expect(gridProps().editOnType).toBe(false);
    expect(gridProps().fillHandle).toBe(false);
    const grid = screen.getByTestId('grid');
    fireEvent.pointerDown(grid, { clientY: 500, pointerType: 'touch' });
    act(() => gridProps().onCellActivated!([1, 0], { inputType: 'pointer', pointerActivation: 'second-click', pointerType: 'touch' }));
    // Not yet: the emulated mousedown after the tap would take the focus away again.
    expect(document.activeElement).not.toBe(formulaInput());
    const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
    act(() => void grid.dispatchEvent(touchEnd));
    expect(touchEnd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(formulaInput());
    expect(formulaInput().value).toBe('1450');
    // Enter commits and moves on to the next cell with the keyboard still up.
    fireEvent.change(formulaInput(), { target: { value: '1500' } });
    fireEvent.keyDown(formulaInput(), { key: 'Enter' });
    expect(nameBox().value).toBe('B3');
    expect(document.activeElement).toBe(formulaInput());
    expect(formulaInput().value).toBe('487.5');
    expect(formulaInput()).toHaveAttribute('enterkeyhint', 'next');
    fireEvent.blur(formulaInput());
    expect((await saved(path)).sheets[0].cells.B2).toEqual({ v: 1500 });
  });
});

describe('number formats, charts, import and export (6b, 6c)', () => {
  const button = (name: string) => screen.getByRole('button', { name });
  const option = (label: string) => within(screen.getByRole('dialog')).getByText(label).closest('button') as HTMLButtonElement;

  it('formats the selection, whole columns and typed values, and shows them formatted', async () => {
    const path = await openGrid();
    select(1, 0, 1, 2); // B2:B3
    fireEvent.click(button('Number format'));
    expect(within(screen.getByRole('dialog')).getByText('For B2:B3')).toBeInTheDocument();
    fireEvent.click(option('Currency'));
    expect(screen.getByTestId('cell-B0')).toHaveTextContent('$1,450.00');
    let cells = (await saved(path)).sheets[0].cells;
    expect(cells.B2).toEqual({ v: 1450, fmt: '$#,##0.00' });
    expect(cells.B3).toEqual({ v: 487.5, fmt: '$#,##0.00' });
    // One more decimal place, on every selected cell.
    fireEvent.click(button('Increase decimal places'));
    expect(screen.getByTestId('cell-B1')).toHaveTextContent('$487.500');
    // A typed percentage brings its format; the formula bar shows it as typed.
    select(3, 0);
    fireEvent.focus(formulaInput());
    fireEvent.change(formulaInput(), { target: { value: '12.5%' } });
    fireEvent.keyDown(formulaInput(), { key: 'Enter' });
    expect(screen.getByTestId('cell-D0')).toHaveTextContent('12.5%');
    select(3, 0);
    expect(formulaInput().value).toBe('12.5%');
    // Whole columns take a column format, and their cells lose their own.
    const { CompactSelection } = await import('@glideapps/glide-data-grid');
    fireEvent.pointerDown(screen.getByTestId('grid'), { clientY: 500, pointerType: 'mouse' });
    act(() => gridProps().onGridSelectionChange!({ columns: CompactSelection.fromSingleSelection(1), rows: CompactSelection.empty() }));
    fireEvent.click(button('Number format'));
    expect(within(screen.getByRole('dialog')).getByText('For column B')).toBeInTheDocument();
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Custom format'), { target: { value: '#,##0' } });
    expect(within(screen.getByRole('dialog')).getByLabelText('Preview')).toHaveTextContent('1,235');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }));
    const file = await saved(path);
    cells = file.sheets[0].cells;
    expect(file.sheets[0].cols.B).toEqual({ fmt: '#,##0' });
    expect(cells.B2).toEqual({ v: 1450 });
    expect(cells.D2).toEqual({ v: 0.125, fmt: '0.0%' });
    expect(screen.getByTestId('cell-B3')).toHaveTextContent('1,938');
    // Undo brings the cell formats back in one step.
    act(() => void activeSheet(path)!.undo());
    expect((await saved(path)).sheets[0].cells.B2).toEqual({ v: 1450, fmt: '$#,##0.000' });
  });

  it('inserts a chart of the selection, edits and deletes it', async () => {
    const path = await openGrid();
    fireEvent.change(nameBox(), { target: { value: 'A1:B3' } });
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    fireEvent.click(button('Insert chart'));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Range') as HTMLInputElement).value).toBe('A1:B3');
    expect(within(dialog).getByLabelText('Row 1 names the series')).toBeChecked();
    expect(within(dialog).getByLabelText('Column A labels the categories')).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Costs' } });
    expect(within(dialog).getByRole('figure')).toHaveAttribute('aria-label', 'Bar chart: Costs');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));
    let charts = (await saved(path)).sheets[0].charts;
    const [id] = Object.keys(charts);
    expect(charts[id]).toEqual({ type: 'bar', range: 'A1:B3', title: 'Costs', headers: true, labels: true });
    const pane = screen.getByRole('region', { name: 'Charts' });
    expect(within(pane).getByRole('figure')).toHaveAttribute('aria-label', 'Bar chart: Costs');

    fireEvent.click(within(pane).getByRole('button', { name: 'Edit chart Costs' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: 'Pie' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    charts = (await saved(path)).sheets[0].charts;
    expect(charts[id].type).toBe('pie');

    fireEvent.click(within(pane).getByRole('button', { name: 'Delete chart Costs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Charts' })).toBeNull());
    expect((await saved(path)).sheets[0].charts).toEqual({});
    act(() => void activeSheet(path)!.undo());
    expect(Object.keys((await saved(path)).sheets[0].charts)).toEqual([id]);
  });

  it('refuses a chart range on another sheet', async () => {
    await openGrid();
    fireEvent.click(button('Insert chart'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Range'), { target: { value: 'Notes!A1:A3' } });
    expect(within(dialog).getByText('A chart shows a range of its own sheet.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Insert' })).toBeDisabled();
  });

  it('imports a CSV file into a new sheet, and downloads the sheet as CSV and the workbook as Excel', async () => {
    const { setFilePicker } = await import('../../features/attachments');
    const csv = new File(['Date;Amount\n2026-10-17;12\n'], 'Bank.csv', { type: 'text/csv' });
    setFilePicker(async () => [csv]);
    const path = await openGrid();
    fireEvent.click(button('Import CSV or Excel'));
    const dialog = await screen.findByRole('dialog', { name: 'Import Bank.csv' });
    expect((within(dialog).getByLabelText('Separator') as HTMLSelectElement).value).toBe(';');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await screen.findByRole('tab', { name: 'Bank' });
    const file = await saved(path);
    expect(file.sheets.map((s) => s.name)).toEqual(['Budget', 'Notes', 'Bank']);
    expect(file.sheets[2].cells).toMatchObject({ A2: { v: 46312, fmt: 'yyyy-mm-dd' }, B2: { v: 12 } });
    setFilePicker(null);

    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:test';
    });
    const urls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('tab', { name: 'Budget' }));
    fireEvent.click(button('Download as CSV or Excel'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download “Budget” as CSV' }));
    expect(await blobs[0].text()).toBe('Item,Cost,\r\nRent,1450,0.7483870968\r\nFood,487.5,\r\n,,\r\n,1937.5,\r\n');
    fireEvent.click(button('Download as CSV or Excel'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }));
    await waitFor(() => expect(blobs).toHaveLength(2), { timeout: 5000 });
    const XLSX = await import('xlsx');
    const book = XLSX.read(new Uint8Array(await blobs[1].arrayBuffer()), { type: 'array', cellFormula: true });
    expect(book.SheetNames).toEqual(['Budget', 'Notes', 'Bank']);
    expect(book.Sheets.Budget.B5).toMatchObject({ f: 'SUM(B2:B4)', v: 1937.5 });
    click.mockRestore();
    Object.assign(URL, urls);
  });

  it('imports into a new spreadsheet file next to the open one', async () => {
    const { setFilePicker } = await import('../../features/attachments');
    setFilePicker(async () => [new File(['a,b\n1,2\n'], 'Small.csv', { type: 'text/csv' })]);
    await openGrid();
    fireEvent.click(button('Import CSV or Excel'));
    const dialog = await screen.findByRole('dialog', { name: 'Import Small.csv' });
    fireEvent.click(within(dialog).getByLabelText('A new spreadsheet file'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(() => vault.readFile('Small.sheet')).not.toThrow());
    const parsed = parseSheet(vault.readFile('Small.sheet').content);
    expect(parsed.ok && parsed.file.sheets[0].cells).toEqual({ A1: { v: 'a' }, B1: { v: 'b' }, A2: { v: 1 }, B2: { v: 2 } });
    expect(parsed.ok && parsed.file.engine).toBe('');
    setFilePicker(null);
  });

  it('opens at the sheet the route names', async () => {
    await openGrid(BUDGET, '#Notes');
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens with the range a link names selected', async () => {
    await openGrid(BUDGET, `#${encodeURIComponent('Budget!B2:C3')}`);
    expect(nameBox().value).toBe('B2:C3');
  });
});
