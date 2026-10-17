// The `sheet` view descriptor (DESIGN §6.21.5): `.sheet` files open in the spreadsheet grid, a
// lazy chunk with Glide Data Grid and HyperFormula. Everything here is in the main bundle and
// small: the format and the cell-level merge, so conflicts merge without loading the engine.
import { FileSpreadsheet } from 'lucide-react';
import type { Command } from '../../features/commands';
import { activeSheet, type SheetActions } from '../../sheets/activeSheet';
import { newSheetFile, serializeSheet } from '../../sheets/format';
import { mergeSheetText } from '../../sheets/merge';
import { registerView } from '../registry';

/** `.sheet` (6, the length of the suffix). */
export function matchSheet(path: string): number {
  return path.toLowerCase().endsWith('.sheet') ? 6 : 0;
}

function sheetCommand(id: string, name: string, run: (a: SheetActions) => void, opts: { editorHotkey?: string; edits?: boolean } = {}): Command {
  return {
    id: `sheet.${id}`,
    name,
    editorHotkey: opts.editorHotkey,
    when: (c) => {
      const a = activeSheet(c.activePath);
      return a !== null && (opts.edits === false || a.editable());
    },
    run: (c) => {
      const a = activeSheet(c.activePath);
      if (a) run(a);
    },
  };
}

export const SHEET_COMMANDS: Command[] = [
  sheetCommand('undo', 'Undo spreadsheet edit', (a) => a.undo(), { editorHotkey: 'Mod-z' }),
  sheetCommand('redo', 'Redo spreadsheet edit', (a) => a.redo(), { editorHotkey: 'Mod-Shift-z' }),
  sheetCommand('fillDown', 'Fill down', (a) => a.fillDown(), { editorHotkey: 'Mod-d' }),
  sheetCommand('fillRight', 'Fill right', (a) => a.fillRight(), { editorHotkey: 'Mod-r' }),
  sheetCommand('boldRows', 'Bold or unbold the selected rows', (a) => a.toggleBoldRows(), { editorHotkey: 'Mod-b' }),
  sheetCommand('freezeRows', 'Freeze rows up to the selected cell', (a) => a.freezeRows()),
  sheetCommand('freezeColumns', 'Freeze columns up to the selected cell', (a) => a.freezeColumns()),
  sheetCommand('unfreeze', 'Unfreeze rows and columns', (a) => a.unfreeze()),
  sheetCommand('columnWidth', 'Set column width…', (a) => a.openColumnWidth()),
  sheetCommand('addSheet', 'Add sheet', (a) => a.addSheet()),
  sheetCommand('namedRanges', 'Named ranges…', (a) => a.openNamedRanges(), { edits: false }),
];

export function registerSheetView(): void {
  registerView({
    id: 'sheet',
    match: (e) => matchSheet(e.path),
    icon: FileSpreadsheet,
    textual: true,
    modes: ['edit'],
    load: () => import('./SheetView'),
    create: { label: 'spreadsheet', extension: 'sheet', initialContent: () => serializeSheet(newSheetFile()) },
    merge: mergeSheetText,
    commands: SHEET_COMMANDS,
  });
}
