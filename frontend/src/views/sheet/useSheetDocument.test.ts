// The spreadsheet's binding of a DocumentSession to a Workbook, with the real engine and session
// over the mock vault: opening, saving, remote changes, Take theirs, merges and refused files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../../api/mock/vault';
import { ENGINE_ID, type Workbook } from '../../sheets/engine';
import { cellValue, parseSheet, serializeSheet, type SheetFile } from '../../sheets/format';
import { mergeSheetText } from '../../sheets/merge';
import { DocumentSession } from '../../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../../test/fakes';
import { clearSheetBindings, sheetBinding, type SheetDocument } from './useSheetDocument';

function sheetText(cells: Record<string, unknown>, engine = ENGINE_ID): string {
  const file = parseSheet(JSON.stringify({ type: 'notesapp-sheet', version: 1, engine, sheets: [{ id: 's1', name: 'Budget', cells }], named: {} }));
  if (!file.ok) throw new Error(file.error);
  return serializeSheet(file.file);
}

const BASE = sheetText({ A1: { v: 1 }, A2: { v: 2 }, A3: { f: '=SUM(A1:A2)', c: 3 } });

function setup(content = BASE, merge = false) {
  const vault = new MockVault(false);
  vault.createFile({ path: 'b.sheet', content }, 'other-device-1');
  const fake = fakeApi(vault);
  const deps = sessionDeps(fake.api, merge ? { mergeFor: () => mergeSheetText } : {});
  const session = new DocumentSession('b.sheet', deps);
  const binding = sheetBinding(session);
  const seen: SheetDocument[] = [];
  const off = binding.subscribe(() => seen.push(binding.getSnapshot()));
  return { vault, fake, deps, session, binding, seen, off };
}

/** Lets the session load and the engine chunk resolve. */
async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

function ready(binding: ReturnType<typeof sheetBinding>): Workbook {
  const doc = binding.getSnapshot();
  if (doc.kind !== 'ready') throw new Error(`not ready: ${doc.kind}`);
  return doc.workbook;
}

const savedFile = (vault: MockVault): SheetFile => {
  const p = parseSheet(vault.readFile('b.sheet').content);
  if (!p.ok) throw new Error(p.error);
  return p.file;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearSheetBindings();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the spreadsheet binding', () => {
  it('opens the session text as a workbook without saving a current file', async () => {
    const { binding, session, fake } = setup();
    expect(binding.getSnapshot().kind).toBe('loading');
    await settle();
    const wb = ready(binding);
    expect(cellValue(wb.cell('s1', 'A3'))).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.getSnapshot().status).toBe('clean');
    expect(fake.api.saveFile).not.toHaveBeenCalled();
  });

  it('saves a file another engine computed once, with this engine and its values', async () => {
    const { binding, vault } = setup(sheetText({ A1: { v: 2 }, A2: { f: '=A1*10', c: 999 } }, 'hyperformula@0.1.0'));
    await settle();
    ready(binding);
    await vi.advanceTimersByTimeAsync(1000);
    const file = savedFile(vault);
    expect(file.engine).toBe(ENGINE_ID);
    expect(file.sheets[0].cells.A2.c).toBe(20);
  });

  it('marks edits dirty with a lazy serializer and saves the stable layout', async () => {
    const { binding, session, vault, seen } = setup();
    await settle();
    const wb = ready(binding);
    const before = seen.length;
    wb.setCell('s1', 'A1', { v: 10 });
    expect(session.getSnapshot().status).toBe('dirty');
    expect(seen.length).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('b.sheet').content).toBe(sheetText({ A1: { v: 10 }, A2: { v: 2 }, A3: { f: '=SUM(A1:A2)', c: 12 } }));
    // Undo is a local edit too.
    wb.undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(savedFile(vault).sheets[0].cells.A1.v).toBe(1);
  });

  it("applies another device's change to the workbook and never saves its stale values", async () => {
    const { binding, session, vault, fake } = setup();
    await settle();
    const wb = ready(binding);
    // A merged file from elsewhere: engine "" (stale), cached values not yet recalculated.
    vault.externalWrite('b.sheet', sheetText({ A1: { v: 5 }, A2: { v: 2 }, A3: { f: '=SUM(A1:A2)', c: 3 } }, ''));
    await session.onRemoteChanged({ version: vault.readFile('b.sheet').version });
    expect(cellValue(wb.cell('s1', 'A3'))).toBe(7);
    expect(wb.canUndo()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.api.saveFile).not.toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('clean');
  });

  it('Take theirs is one undo step in the workbook', async () => {
    const { binding, session, vault } = setup();
    await settle();
    const wb = ready(binding);
    vault.externalWrite('b.sheet', sheetText({ A1: { v: 100 }, A2: { v: 2 }, A3: { f: '=SUM(A1:A2)', c: 102 } }));
    wb.setCell('s1', 'A1', { v: 50 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().status).toBe('conflict');
    await session.takeTheirs();
    expect(cellValue(wb.cell('s1', 'A1'))).toBe(100);
    expect(session.getSnapshot().status).toBe('clean');
    wb.undo();
    expect(cellValue(wb.cell('s1', 'A1'))).toBe(50);
    expect(session.getSnapshot().status).toBe('dirty');
  });

  it('merges edits of different cells without the banner and saves recalculated values', async () => {
    const { binding, session, vault } = setup(BASE, true);
    await settle();
    const wb = ready(binding);
    vault.externalWrite('b.sheet', sheetText({ A1: { v: 1 }, A2: { v: 20 }, A3: { f: '=SUM(A1:A2)', c: 21 } }));
    wb.setCell('s1', 'A1', { v: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().status).not.toBe('conflict');
    expect(cellValue(wb.cell('s1', 'A3'))).toBe(30);
    await vi.advanceTimersByTimeAsync(2000);
    const file = savedFile(vault);
    expect(file.sheets[0].cells.A1.v).toBe(10);
    expect(file.sheets[0].cells.A2.v).toBe(20);
    expect(file.sheets[0].cells.A3.c).toBe(30);
    expect(file.engine).toBe(ENGINE_ID);
  });

  it('refuses a file it cannot read, leaves it alone, and opens it once fixed', async () => {
    const { binding, session, vault, fake } = setup('{"type": "notesapp-sheet", "version": 1, "sheets": [], "sheets": []}');
    await settle();
    const doc = binding.getSnapshot();
    expect(doc.kind).toBe('refused');
    expect(doc.kind === 'refused' && doc.message).toMatch(/twice/);
    // Another device fixes it: the binding reads the new text by itself.
    vault.externalWrite('b.sheet', BASE);
    await session.onRemoteChanged({ version: vault.readFile('b.sheet').version });
    expect(cellValue(ready(binding).cell('s1', 'A3'))).toBe(3);
    expect(fake.api.saveFile).not.toHaveBeenCalled();
  });

  it('opens a file fixed in the text editor on Retry', async () => {
    const { binding, session } = setup('not json');
    await settle();
    expect(binding.getSnapshot().kind).toBe('refused');
    session.setText(BASE);
    expect(binding.getSnapshot().kind).toBe('ready');
    binding.retry();
    expect(binding.getSnapshot().kind).toBe('ready');
  });

  it('shows a file the engine cannot open as refused, untouched', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Workbook } = await import('../../sheets/engine');
    vi.spyOn(Workbook, 'open').mockImplementationOnce(() => {
      throw new Error('out of cells');
    });
    const { binding, fake } = setup();
    await settle();
    const doc = binding.getSnapshot();
    expect(doc.kind === 'refused' && doc.message).toContain('engine could not open it (out of cells)');
    expect(errors).toHaveBeenCalled();
    binding.retry();
    expect(binding.getSnapshot().kind).toBe('ready');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.api.saveFile).not.toHaveBeenCalled();
  });

  it('shows a file that became unreadable as refused', async () => {
    const { binding, session, vault } = setup();
    await settle();
    ready(binding);
    vault.externalWrite('b.sheet', '{"type": "something-else"}');
    await session.onRemoteChanged({ version: vault.readFile('b.sheet').version });
    expect(binding.getSnapshot().kind).toBe('refused');
  });

  it('keeps the workbook (and its undo history) while the view is away', async () => {
    const { binding, off } = setup();
    await settle();
    const wb = ready(binding);
    wb.setCell('s1', 'A1', { v: 9 });
    off();
    const again = binding.subscribe(() => {});
    expect(ready(binding)).toBe(wb);
    expect(wb.canUndo()).toBe(true);
    again();
  });

  it('reports an engine that failed to load, and tries again', async () => {
    // Fresh modules: the engine is not loaded yet.
    vi.resetModules();
    const freshLoader = await import('../../sheets/loadEngine');
    const fresh = await import('./useSheetDocument');
    const real = freshLoader.loadSheetEngine;
    const spy = vi.spyOn(freshLoader, 'loadSheetEngine').mockRejectedValueOnce(new Error('offline'));
    const vault = new MockVault(false);
    vault.createFile({ path: 'c.sheet', content: BASE }, 'o');
    const session = new DocumentSession('c.sheet', sessionDeps(fakeApi(vault).api));
    const binding = fresh.sheetBinding(session);
    binding.subscribe(() => {});
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot()).toEqual({ kind: 'failed', message: 'offline' });
    spy.mockImplementation(real);
    binding.retry();
    await settle();
    expect(binding.getSnapshot().kind).toBe('ready');
    fresh.clearSheetBindings();
  });
});
