import { act, renderHook } from '@testing-library/react';
import { FileSpreadsheet } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileEntry } from '../../api/types';
import { activeSheet, setActiveSheet, type SheetActions } from '../../sheets/activeSheet';
import { parseSheet } from '../../sheets/format';
import { mergeSheetText } from '../../sheets/merge';
import { viewFor } from '../registry';
import { matchSheet, registerSheetView, SHEET_COMMANDS } from './register';
import { sheetTheme, useSheetTheme } from './theme';

function entry(path: string): FileEntry {
  return { path, name: path, basename: path, extension: 'sheet', kind: 'text', size: 1, mtime: '2026-10-17T10:00:00.000Z', version: 'v', aliases: [] };
}

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

describe('the sheet view descriptor', () => {
  it('opens .sheet files (any case) with the spreadsheet icon, cell merge and a "spreadsheet" create item', async () => {
    registerSheetView();
    expect(matchSheet('Budget.sheet')).toBe(6);
    expect(matchSheet('a/B.SHEET')).toBe(6);
    expect(matchSheet('notes.sheet.md')).toBe(0);
    const d = viewFor(entry('Budget.sheet'));
    expect(d).toMatchObject({ id: 'sheet', textual: true, modes: ['edit'], icon: FileSpreadsheet, merge: mergeSheetText });
    expect(d.create?.label).toBe('spreadsheet');
    expect(d.create?.extension).toBe('sheet');
    const created = parseSheet(d.create!.initialContent());
    expect(created.ok && created.file.sheets.map((s) => [s.name, Object.keys(s.cells).length])).toEqual([['Sheet1', 0]]);
    expect(d.commands).toBe(SHEET_COMMANDS);
    expect((await d.load()).default).toBeTypeOf('function');
  });

  it('offers its palette commands only while a spreadsheet shows the open file, edits only when editable', () => {
    const calls: string[] = [];
    let editable = true;
    const actions = new Proxy({ path: 'a.sheet', editable: () => editable } as SheetActions, {
      get: (t, k: string) => (k in t ? t[k as keyof SheetActions] : () => calls.push(k)),
    });
    const off = setActiveSheet(actions);
    const fill = SHEET_COMMANDS.find((c) => c.id === 'sheet.fillDown')!;
    const named = SHEET_COMMANDS.find((c) => c.id === 'sheet.namedRanges')!;
    expect(fill.when!({ activePath: 'a.sheet' })).toBe(true);
    expect(fill.when!({ activePath: 'b.sheet' })).toBe(false);
    void fill.run({ activePath: 'a.sheet' });
    expect(calls).toEqual(['fillDown']);
    editable = false;
    expect(fill.when!({ activePath: 'a.sheet' })).toBe(false);
    expect(named.when!({ activePath: 'a.sheet' })).toBe(true);
    off();
    expect(activeSheet('a.sheet')).toBeNull();
  });
});

describe('the grid theme', () => {
  it("takes the app's colours from its CSS variables and follows a theme switch", async () => {
    const root = document.documentElement;
    root.style.setProperty('--background-primary', '#101010');
    root.style.setProperty('--text-error', '#ff0000');
    expect(sheetTheme(false)).toMatchObject({ error: '#ff0000', fontSize: 13, grid: { bgCell: '#101010', editorFontSize: '13px' } });
    // 16 px editor text keeps iOS from zooming.
    expect(sheetTheme(true).grid.editorFontSize).toBe('16px');
    const { result } = renderHook(() => useSheetTheme(false));
    expect(result.current.grid.bgCell).toBe('#101010');
    root.style.setProperty('--background-primary', '#fefefe');
    await act(async () => {
      root.setAttribute('data-theme', 'light');
      await Promise.resolve();
    });
    expect(result.current.grid.bgCell).toBe('#fefefe');
  });
});
