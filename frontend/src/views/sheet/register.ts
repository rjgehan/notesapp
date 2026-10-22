// The `sheet` view descriptor (DESIGN §6.21.5): `.sheet` files open in the spreadsheet grid, a
// lazy chunk with Glide Data Grid and HyperFormula, and `![[x.sheet]]` embeds render through
// loadEmbed(), a small chunk without the engine (§6.21.7). This module is in the main bundle and
// small; the format and the cell-level merge are a chunk that loads with the view
// (views/lazyMerge.ts), so conflicts merge without loading the engine.
import { FileSpreadsheet } from 'lucide-react';
import { pickFiles } from '../../features/attachments';
import { registerCommand, type Command } from '../../features/commands';
import { toastError } from '../../features/errors';
import { newNoteFolder } from '../../features/fileOps';
import { activeSheet, type SheetActions } from '../../sheets/activeSheet';
import { toast } from '../../state/toasts';

/** What the import buttons and commands accept (importExport.ts reads them). */
export const IMPORT_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods,text/csv,text/tab-separated-values';
import { NEW_SHEET_TEXT } from '../../sheets/newSheet';
import { lazyMerge, withMerge } from '../lazyMerge';
import { registerView } from '../registry';

/** The cell-level merge (sheets/merge.ts). */
export const sheetMerge = lazyMerge(() => import('../../sheets/merge').then((m) => m.mergeSheetText));

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
  sheetCommand('insertRowsAbove', 'Insert rows above', (a) => a.insertRowsAbove()),
  sheetCommand('insertRowsBelow', 'Insert rows below', (a) => a.insertRowsBelow()),
  sheetCommand('insertColumnsLeft', 'Insert columns left', (a) => a.insertColumnsLeft()),
  sheetCommand('insertColumnsRight', 'Insert columns right', (a) => a.insertColumnsRight()),
  sheetCommand('deleteRows', 'Delete the selected rows', (a) => a.deleteRows()),
  sheetCommand('deleteColumns', 'Delete the selected columns', (a) => a.deleteColumns()),
  sheetCommand('namedRanges', 'Named ranges…', (a) => a.openNamedRanges(), { edits: false }),
  sheetCommand('numberFormat', 'Number format…', (a) => a.openNumberFormat()),
  sheetCommand('increaseDecimals', 'Increase decimal places', (a) => a.increaseDecimals()),
  sheetCommand('decreaseDecimals', 'Decrease decimal places', (a) => a.decreaseDecimals()),
  sheetCommand('insertChart', 'Insert chart…', (a) => a.insertChart()),
  sheetCommand('importFile', 'Import CSV or Excel into this spreadsheet…', (a) => a.importFile(), { edits: false }),
  sheetCommand('exportCsv', 'Download sheet as CSV', (a) => a.exportCsv(), { edits: false }),
  sheetCommand('exportXlsx', 'Download spreadsheet as Excel (.xlsx)', (a) => a.exportXlsx(), { edits: false }),
];

/**
 * "Import spreadsheet from CSV or Excel…" anywhere: the file becomes a new .sheet file in the
 * new-note folder (DESIGN §6.21.10). The picker opens inside the palette's gesture; reading the
 * file loads the import module (and SheetJS for workbooks) afterwards.
 */
async function importAsNewFile(activePath: string | null): Promise<void> {
  const [file] = await pickFiles({ accept: IMPORT_ACCEPT, multiple: false });
  if (!file) return;
  const { importKind, readCsvFile, readWorkbookFile, csvBook, bookToFile, createSheetFile, baseName } = await import('./importExport');
  const kind = importKind(file.name);
  if (!kind) {
    toast('Choose a CSV, TSV or Excel file to import.', { kind: 'error' });
    return;
  }
  try {
    let book;
    if (kind === 'csv') {
      const { text, separator } = await readCsvFile(file);
      book = csvBook(file.name, text, separator, true);
    } else book = await readWorkbookFile(file);
    await createSheetFile(newNoteFolder(activePath), baseName(file.name), bookToFile(book));
    toast([`Imported “${file.name}”.`, ...book.skipped.slice(0, 3)].join(' '), { timeout: book.skipped.length > 0 ? 10000 : 4000 });
  } catch (e) {
    toastError(e, `Could not import ${file.name}`);
  }
}

export function registerSheetView(): void {
  registerView({
    id: 'sheet',
    match: (e) => matchSheet(e.path),
    icon: FileSpreadsheet,
    textual: true,
    modes: ['edit'],
    load: withMerge(sheetMerge, () => import('./SheetView')),
    loadEmbed: withMerge(sheetMerge, () => import('./SheetEmbed')),
    create: { label: 'spreadsheet', extension: 'sheet', initialContent: () => NEW_SHEET_TEXT },
    merge: sheetMerge.merge,
    commands: SHEET_COMMANDS,
  });
  registerCommand({ id: 'sheet.importAsFile', name: 'Import spreadsheet from CSV or Excel…', icon: FileSpreadsheet, run: (c) => importAsNewFile(c.activePath) });
}
