// The spreadsheet's half of the textual-view contract (DESIGN §6.8, §6.21.4): the session holds the
// file, a Workbook holds the parsed, calculated model. Local edits mark the session dirty with a
// lazy serializer; text the session puts into the buffer itself (another device's change, Take
// theirs, a merge, a restored draft) goes into the workbook with replace().
//
// A binding per session does this outside React; views subscribe to its snapshot. Bindings (and
// their workbooks) stay cached for a few files that are not shown, so the undo history survives
// switching between files, as CodeMirror's states do for notes.
import { useSyncExternalStore } from 'react';
import type { Workbook } from '../../sheets/engine';
import { parseSheet } from '../../sheets/format';
import { loadSheetEngine, type SheetEngine } from '../../sheets/loadEngine';
import type { DocumentSession } from '../../sync/DocumentSession';

export type SheetDocument =
  | { kind: 'loading' }
  /** The engine chunk could not be loaded (offline, a deploy). */
  | { kind: 'failed'; message: string }
  /** The parser refused the file: it stays untouched, to be fixed as text. */
  | { kind: 'refused'; message: string }
  /** `version` changes with every change of the workbook. */
  | { kind: 'ready'; workbook: Workbook; version: number };

const LOADING: SheetDocument = { kind: 'loading' };

/** Bindings kept for files that are not shown; older ones are destroyed. */
const CACHE_LIMIT = 3;
const bindings = new Map<DocumentSession, SheetBinding>();
let engine: SheetEngine | null = null;
let clock = 0;

export class SheetBinding {
  private readonly session: DocumentSession;
  private state: SheetDocument = LOADING;
  private workbook: Workbook | null = null;
  /** The session's remoteChangeCount the workbook has caught up with. */
  private seen = -1;
  private version = 0;
  private loadingEngine = false;
  private readonly listeners = new Set<() => void>();
  private offSession: (() => void) | null = null;
  private offWorkbook: (() => void) | null = null;
  lastUsed = 0;

  constructor(session: DocumentSession) {
    this.session = session;
  }

  get held(): boolean {
    return this.listeners.size > 0;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    this.lastUsed = ++clock;
    if (!this.offSession) {
      this.offSession = this.session.subscribe(this.sync);
      this.sync();
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        this.offSession?.();
        this.offSession = null;
        evict();
      }
    };
  };

  getSnapshot = (): SheetDocument => this.state;

  /** Tries again after a failed engine load or a refused file (fixed in the text editor). */
  retry = (): void => {
    if (this.state.kind === 'failed' || this.state.kind === 'refused') {
      this.set(LOADING);
      this.sync();
    }
  };

  destroy(): void {
    this.offSession?.();
    this.offSession = null;
    this.offWorkbook?.();
    this.offWorkbook = null;
    // A dirty session may still serialize this model on its way out: serialize() needs no engine.
    this.workbook?.destroy();
    this.workbook = null;
  }

  private set(state: SheetDocument): void {
    this.state = state;
    for (const fn of [...this.listeners]) fn();
  }

  private ready(): void {
    this.set({ kind: 'ready', workbook: this.workbook!, version: ++this.version });
  }

  private sync = (): void => {
    const session = this.session;
    if (!session.getSnapshot().loaded || this.state.kind === 'failed') return;
    if (!engine) {
      this.loadEngine();
      return;
    }
    if (this.state.kind === 'refused') {
      // Read again only for new text from the session (a fix from another device); a fix typed
      // into the text editor is picked up by Retry, so a large file is not parsed per keystroke.
      if (this.seen !== session.remoteChangeCount) this.open(engine);
      return;
    }
    if (!this.workbook) this.open(engine);
    else if (this.seen !== session.remoteChangeCount) this.catchUp();
  };

  private loadEngine(): void {
    if (this.loadingEngine) return;
    this.loadingEngine = true;
    loadSheetEngine().then(
      (e) => {
        engine = e;
        this.loadingEngine = false;
        this.sync();
      },
      (e: unknown) => {
        this.loadingEngine = false;
        this.set({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  private open(e: SheetEngine): void {
    const session = this.session;
    this.seen = session.remoteChangeCount;
    const parsed = parseSheet(session.getText());
    if (!parsed.ok) {
      this.set({ kind: 'refused', message: parsed.error });
      return;
    }
    let wb: Workbook;
    try {
      wb = e.Workbook.open(parsed.file);
    } catch (err) {
      // The engine could not calculate the file: shown like a refused file, untouched.
      console.error('[notesapp] the sheet engine could not open the file', err);
      this.set({ kind: 'refused', message: `The spreadsheet engine could not open it (${err instanceof Error ? err.message : String(err)}).` });
      return;
    }
    this.workbook = wb;
    this.offWorkbook = wb.subscribe((change) => {
      // Text from the session is already in the buffer; everything else is a local edit.
      if (change.origin !== 'replace') this.session.markDirty(() => wb.serialize());
      this.ready();
    });
    // Values computed by another engine (or missing) are saved once; repairs wait for an edit.
    if (wb.stale && session.isEditable()) session.markDirty(() => wb.serialize());
    this.ready();
  }

  /**
   * The buffer's text into the workbook. Recalculated cached values are saved only for a change of
   * this device's own making (a merge, a restored draft or text: the session holds unsaved text
   * then), never for another device's change, so two devices never trade cache-only saves.
   */
  private catchUp(): void {
    const session = this.session;
    const wb = this.workbook!;
    this.seen = session.remoteChangeCount;
    const parsed = parseSheet(session.getText());
    if (!parsed.ok) {
      // Another device wrote something this version cannot read: shown as refused, untouched.
      this.offWorkbook?.();
      this.offWorkbook = null;
      wb.destroy();
      this.workbook = null;
      this.set({ kind: 'refused', message: parsed.error });
      return;
    }
    const { stale } = wb.replace(parsed.file, { undoable: session.remoteChangeUndoable });
    if (stale && session.isEditable() && session.hasUnsavedChanges()) session.markDirty(() => wb.serialize());
  }
}

function evict(): void {
  const idle = [...bindings.entries()].filter(([, b]) => !b.held).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (idle.length > CACHE_LIMIT) {
    const [session, binding] = idle.shift()!;
    bindings.delete(session);
    binding.destroy();
  }
}

export function sheetBinding(session: DocumentSession): SheetBinding {
  let binding = bindings.get(session);
  if (!binding) {
    binding = new SheetBinding(session);
    bindings.set(session, binding);
  }
  return binding;
}

/** Forgets every cached binding (tests). */
export function clearSheetBindings(): void {
  for (const b of bindings.values()) b.destroy();
  bindings.clear();
}

export function useSheetDocument(session: DocumentSession): SheetDocument {
  const binding = sheetBinding(session);
  return useSyncExternalStore(binding.subscribe, binding.getSnapshot);
}
