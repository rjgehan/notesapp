// The open spreadsheet's actions, for the palette commands its view descriptor contributes
// (DESIGN §6.21.5). The lazy view sets them while it is mounted; the commands live in the main
// bundle and never load the view or the engine themselves.

export interface SheetActions {
  path: string;
  editable(): boolean;
  undo(): void;
  redo(): void;
  fillDown(): void;
  fillRight(): void;
  toggleBoldRows(): void;
  freezeRows(): void;
  freezeColumns(): void;
  unfreeze(): void;
  addSheet(): void;
  openNamedRanges(): void;
  openColumnWidth(): void;
  openNumberFormat(): void;
  increaseDecimals(): void;
  decreaseDecimals(): void;
  insertChart(): void;
  importFile(): void;
  exportCsv(): void;
  exportXlsx(): void;
}

let active: SheetActions | null = null;

/** Registers the mounted view's actions; returns the matching cleanup. */
export function setActiveSheet(actions: SheetActions): () => void {
  active = actions;
  return () => {
    if (active === actions) active = null;
  };
}

/** The actions of the spreadsheet showing `path`, if one is mounted. */
export function activeSheet(path: string | null): SheetActions | null {
  return active && path !== null && active.path === path ? active : null;
}
