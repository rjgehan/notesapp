// Formulas in notes (ROADMAP item 39, DESIGN §6.42) in Live Preview and locked notes: a table cell
// whose text starts with `=` shows its result (editing the cell shows the formula, and the grid's
// formula bar its result), and inline code that starts with `=` shows its result while the
// selection is elsewhere. The note's text is never changed: results are computed from it.
//
// A state field keeps the note's tables as the engine sees them (their cells, names and column
// formats), reusing what an edit did not touch. The engine is a lazy chunk; it loads the first time
// a note with formulas shows, and the results of one version of the tables are computed once.
import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { NoteResults } from '../../formulas/engine';
import { cancelFormulaWait, loadedFormulaEngine, loadFormulaEngine } from '../../formulas/load';
import { formulasOff, isFormula, sheetNames, tableAnnotations, tableNeedsEngine, type FormulaDisplay, type FormulaModel } from '../../formulas/model';
import { redrawTableDisplays, refreshTables, tableCellFormatters } from './table';
import { tableSheetName } from './table/facets';
import { gridRows, parseTable } from './table/model';
import { topLevel, wholeLines } from './topLevel';

interface Entry {
  from: number;
  to: number;
  text: string;
  rows: string[][];
  id: string | null;
  formats: Record<number, string>;
  /** The annotation lines under the table as read (to notice a changed id or formats line). */
  under: string;
}

export interface FormulaState {
  /** `formulas: false` in the frontmatter. */
  off: boolean;
  entries: readonly Entry[];
  model: FormulaModel;
  /** Whether a table needs the engine (a formula, or column formats). */
  tablesNeedEngine: boolean;
  /** Bumped whenever the results may differ: the tables changed, or the engine loaded. */
  version: number;
}

/** The engine finished loading: results can be computed now. */
const formulasReady = StateEffect.define<null>();

const UNDER_LINES = 3;

function linesUnder(state: EditorState, to: number): string[] {
  const out: string[] = [];
  let line = state.doc.lineAt(to).number;
  for (let i = 0; i < UNDER_LINES && line < state.doc.lines; i++) out.push(state.doc.line(++line).text);
  return out;
}

function frontmatterOff(state: EditorState): boolean {
  if (!state.doc.line(1).text.startsWith('---')) return false;
  const first = syntaxTree(state).topNode.firstChild;
  if (!first || first.name !== 'Frontmatter') return false;
  return formulasOff(state.sliceDoc(first.from, first.to));
}

function sameFormats(a: Record<number, string>, b: Record<number, string>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[Number(k)] === b[Number(k)]);
}

function gather(state: EditorState, previous: FormulaState | null, changes: ChangeDesc | null): FormulaState {
  const kept = new Map<number, Entry>();
  for (const e of previous?.entries ?? []) {
    if (changes && !changes.empty) {
      if (changes.touchesRange(e.from, e.to)) continue;
      const from = changes.mapPos(e.from);
      kept.set(from, { ...e, from, to: changes.mapPos(e.to) });
    } else kept.set(e.from, e);
  }
  const entries: Entry[] = [];
  for (const t of topLevel(state).tables) {
    const lines = wholeLines(state, t);
    if (!lines) continue;
    const under = linesUnder(state, lines.to);
    const underKey = under.join('\n');
    const same = kept.get(lines.from);
    if (same && same.to === lines.to) {
      if (same.under === underKey) entries.push(same);
      else entries.push({ ...same, ...tableAnnotations(under), under: underKey });
      continue;
    }
    const text = state.sliceDoc(lines.from, lines.to);
    const model = parseTable(text);
    if (!model) continue;
    entries.push({ from: lines.from, to: lines.to, text, rows: gridRows(model), ...tableAnnotations(under), under: underKey });
  }
  const off = frontmatterOff(state);
  const unchanged =
    previous !== null &&
    previous.off === off &&
    previous.entries.length === entries.length &&
    previous.entries.every((e, i) => e.text === entries[i].text && e.id === entries[i].id && sameFormats(e.formats, entries[i].formats));
  if (unchanged) return { ...previous, entries };
  const names = sheetNames(entries.map((e) => e.id));
  const tables = entries.map((e, i) => ({ name: names[i], named: e.id !== null, rows: e.rows, formats: e.formats }));
  return {
    off,
    entries,
    model: { tables },
    tablesNeedEngine: !off && tables.some(tableNeedsEngine),
    version: (previous?.version ?? 0) + 1,
  };
}

export const formulaField = StateField.define<FormulaState>({
  create: (state) => gather(state, null, null),
  update(value, tr) {
    if (tr.effects.some((e) => e.is(formulasReady))) return { ...gather(tr.state, value, tr.changes), version: value.version + 1 };
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) return value;
    return gather(tr.state, value, tr.changes);
  },
});

// ---------- results ----------

/** One computation per version of a note's tables (and per loaded engine). */
const computed = new WeakMap<FormulaModel, NoteResults>();

/** The note's results, or null while the engine is not loaded (or formulas are off). */
export function formulaResults(state: EditorState): NoteResults | null {
  const value = state.field(formulaField, false);
  const engine = loadedFormulaEngine();
  if (!value || value.off || !engine) return null;
  let results = computed.get(value.model);
  if (!results) {
    results = engine.computeNote(value.model);
    computed.set(value.model, results);
  }
  return results;
}

const formatter = tableCellFormatters.of((table) => {
  const value = table.state.field(formulaField, false);
  if (!value || value.off) return null;
  const index = value.entries.findIndex((e) => e.from === table.from);
  if (index < 0 || !tableNeedsEngine(value.model.tables[index])) return null;
  const results = formulaResults(table.state);
  return results ? (row, column) => results.cell(index, row, column) : null;
});

const sheetName = tableSheetName.of((state, from) => {
  const value = state.field(formulaField, false);
  if (!value || value.off) return null;
  const index = value.entries.findIndex((e) => e.from === from);
  return index < 0 ? null : (value.model.tables[index]?.name ?? null);
});

// ---------- inline formulas ----------

class InlineFormulaWidget extends WidgetType {
  readonly shown: FormulaDisplay;
  constructor(shown: FormulaDisplay) {
    super();
    this.shown = shown;
  }
  override eq(other: InlineFormulaWidget): boolean {
    return other.shown.text === this.shown.text && other.shown.className === this.shown.className && other.shown.title === this.shown.title;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-formula-inline${this.shown.className ? ` ${this.shown.className}` : ''}`;
    el.textContent = this.shown.text;
    if (this.shown.title) el.title = this.shown.title;
    return el;
  }
  override ignoreEvent(): boolean {
    // A click puts the caret by the formula, which then shows as typed.
    return false;
  }
}

/** The inline code of the visible lines that holds a formula: its range and its expression. */
function inlineFormulas(view: EditorView): { from: number; to: number; expression: string }[] {
  const { state } = view;
  const out: { from: number; to: number; expression: string }[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Frontmatter' || node.name === 'Table' || node.name === 'CommentBlock' || node.name === 'Comment') return false;
        if (node.name !== 'InlineCode') return;
        const marks = node.node.getChildren('CodeMark');
        if (marks.length < 2) return false;
        const expression = state.sliceDoc(marks[0].to, marks[marks.length - 1].from).trim();
        if (isFormula(expression)) out.push({ from: node.from, to: node.to, expression });
        return false;
      },
    });
  }
  return out;
}

function editable(state: EditorState, locked: boolean): boolean {
  return !locked && !state.readOnly;
}

function buildInline(view: EditorView, locked: boolean, found: { from: number; to: number; expression: string }[]): DecorationSet {
  const results = found.length ? formulaResults(view.state) : null;
  if (!results) return Decoration.none;
  const reveal = editable(view.state, locked);
  const ranges: Range<Decoration>[] = [];
  for (const f of found) {
    if (reveal && view.state.selection.ranges.some((r) => r.from <= f.to && r.to >= f.from)) continue;
    const shown = results.inline(f.expression);
    if (shown) ranges.push(Decoration.replace({ widget: new InlineFormulaWidget(shown) }).range(f.from, f.to));
  }
  return Decoration.set(ranges, true);
}

function formulaPlugin(locked: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private readonly view: EditorView;
      private waiting = false;
      private readonly ready = () => {
        this.waiting = false;
        this.view.dispatch({ effects: [formulasReady.of(null), refreshTables.of(null)] });
      };
      constructor(view: EditorView) {
        this.view = view;
        this.refresh(view);
      }
      update(update: ViewUpdate) {
        const before = update.startState.field(formulaField, false);
        const after = update.state.field(formulaField, false);
        const changed = before?.version !== after?.version || before?.off !== after?.off;
        // Another table's edit can change this table's results: its grid draws its displays again.
        if (changed && after?.tablesNeedEngine) queueMicrotask(() => redrawTableDisplays(update.view));
        if (changed || update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.startState) !== syntaxTree(update.state)) this.refresh(update.view);
      }
      private refresh(view: EditorView) {
        const value = view.state.field(formulaField, false);
        if (!value || value.off) {
          this.decorations = Decoration.none;
          return;
        }
        const found = inlineFormulas(view);
        if ((found.length > 0 || value.tablesNeedEngine) && !loadedFormulaEngine() && !this.waiting) {
          this.waiting = true;
          loadFormulaEngine(this.ready);
        }
        this.decorations = buildInline(view, locked, found);
      }
      destroy() {
        cancelFormulaWait(this.ready);
      }
    },
    { decorations: (p) => p.decorations },
  );
}

/** Formulas in tables and inline code (ROADMAP item 39); `locked` never shows them as typed. */
export function noteFormulas(locked: boolean): Extension {
  // Above Live Preview's inline decorations, so the result replaces the code with its hidden marks.
  return [formulaField, formatter, sheetName, Prec.highest(formulaPlugin(locked))];
}
