// Live Preview (DESIGN §6.6.1, ROADMAP 10a): notes render as you type, in the one editor. The
// markup is hidden or shown as widgets by decorations over the visible ranges; the document stays
// byte for byte what was typed. Hidden markup is atomic, and a few cursor and deletion rules make
// editing feel like a word processor: Backspace at the edge of bold text deletes a letter, typing
// at the end of bold text continues in bold, and typing after a link does not extend it.
import { completionStatus } from '@codemirror/autocomplete';
import { deleteCharBackward } from '@codemirror/commands';
import { deleteMarkupBackward } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Facet, findClusterBreak, Prec, RangeSet, type Extension, type SelectionRange } from '@codemirror/state';
import { Direction, EditorView, keymap, ViewPlugin, type Command, type ViewUpdate } from '@codemirror/view';
import { isCoarsePointer, isIOS, modKey } from '../../features/platform';
import { noteContext, vaultChanged } from '../context';
import { followLink } from '../editorCommands';
import { linkAt } from '../linkAt';
import { liveBlocks } from './blocks';
import { buildLivePreview, revealOptions, type LivePreview, type LivePreviewConfig } from './decorations';
import { footnotesOf, footnoteTooltips } from './footnotes';
import { formatToolbar } from './formatToolbar';
import { inputRules } from './inputRules';
import { collectElements, INLINE_KINDS, lineLayout, type Layout, type Run } from './model';
import { isPointerSelection, touchTracking } from './pointer';
import { tables } from './table';
import { tableCellHost } from './table/facets';

export type { LivePreviewConfig } from './decorations';

/** The Live Preview options of an editor (null: styled source mode). */
export const livePreviewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig | null>({
  combine: (values) => values[0] ?? null,
});

const livePlugin = ViewPlugin.fromClass(
  class {
    live: LivePreview;
    constructor(view: EditorView) {
      this.live = build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        completionStatus(update.startState) !== completionStatus(update.state) ||
        update.startState.facet(livePreviewConfig) !== update.state.facet(livePreviewConfig) ||
        // Embeds and links resolve against the vault.
        update.transactions.some((tr) => tr.effects.some((e) => e.is(vaultChanged)))
      ) {
        this.live = build(update.view);
      }
    }
  },
  { decorations: (p) => p.live.decorations },
);

function build(view: EditorView): LivePreview {
  const config = view.state.facet(livePreviewConfig) ?? { visibility: 'hide-all', locked: false, checkboxes: false };
  return buildLivePreview(view.state, view.visibleRanges, {
    ...config,
    selection: view.state.selection,
    focused: view.hasFocus,
    completing: completionStatus(view.state) !== null,
    note: view.state.facet(noteContext),
    // A table cell's footnotes are its note's.
    footnotes: () => footnotesOf((view.state.facet(tableCellHost) ?? view).state),
  });
}

/** The hidden markup on the line at `pos`, as the editor currently shows it. */
function layoutAt(view: EditorView, pos: number): Layout {
  const config = view.state.facet(livePreviewConfig);
  const options = revealOptions({ visibility: config?.visibility ?? 'hide-all', locked: false, focused: view.hasFocus, completing: completionStatus(view.state) !== null });
  return lineLayout(view.state, pos, view.state.selection, options);
}

/** The single empty cursor of an editable Live Preview editor, or null. */
function editableCursor(view: EditorView): number | null {
  const config = view.state.facet(livePreviewConfig);
  const { selection } = view.state;
  if (!config || config.locked || view.state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return null;
  return selection.main.head;
}

// ---------- cursor placement ----------

/**
 * Where a click at the edge of hidden inline markup puts the cursor: in front of opening markers
 * (typing stays outside), inside closing formatting markers (typing continues the formatting), and
 * after the closing markers of links and code (typing does not extend them).
 */
export function preferredInRun(run: Run): number {
  let pos = run.from;
  for (const p of run.pieces) {
    if (p.role !== 'close-link') break;
    pos = p.to;
  }
  return pos;
}

/**
 * Hide-all mode (DESIGN §6.6.1): a cursor never rests in front of a line's hidden block markup
 * (it moves to where the text starts), and a click at the edge of hidden inline markup lands where
 * typing does what a word processor would. Keyboard moves keep their stops at the markup's edges,
 * which is how you step into or out of formatting.
 */
export function settleCursor(state: EditorState, pos: number, pointer: boolean): number {
  const layout = lineLayout(state, pos);
  const zone = layout.zones.find((z) => pos >= z.from && pos < z.to);
  if (zone) return zone.to;
  if (!pointer) return pos;
  const run = layout.runs.find((r) => pos >= r.from && pos <= r.to);
  if (!run || run.pieces.some((p) => p.role === 'inner')) return pos;
  return preferredInRun(run);
}

const settleSelection = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  const config = tr.startState.facet(livePreviewConfig);
  if (!config || config.locked || config.visibility !== 'hide-all') return tr;
  const pointer = isPointerSelection(tr);
  const state = tr.state;
  let changed = false;
  const ranges = tr.selection.ranges.map((r): SelectionRange => {
    if (!r.empty) return r;
    const pos = settleCursor(state, r.head, pointer);
    if (pos === r.head) return r;
    changed = true;
    return EditorSelection.cursor(pos, pos > r.head ? 1 : -1);
  });
  return changed ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }] : tr;
});

/** ArrowLeft (or a word left) where a line's text starts goes to the end of the line before, over the hidden block markup. */
const leftOverPrefix: Command = (view) => {
  const pos = editableCursor(view);
  if (pos === null || view.textDirectionAt(pos) !== Direction.LTR) return false;
  const zone = layoutAt(view, pos).zones.find((z) => z.to === pos && z.from < pos);
  if (!zone) return false;
  if (zone.from > 0) view.dispatch({ selection: EditorSelection.cursor(zone.from - 1, 1), scrollIntoView: true, userEvent: 'select' });
  return true;
};

/** Enter where a heading's text starts opens a line above it; the heading stays a heading. */
const newLineAboveHeading: Command = (view) => {
  const pos = editableCursor(view);
  if (pos === null || completionStatus(view.state) !== null) return false;
  const line = view.state.doc.lineAt(pos);
  if (pos === line.to) return false;
  const zone = layoutAt(view, pos).zones.find((z) => z.to === pos);
  if (!zone || !zone.pieces.some((p) => p.kind === 'heading')) return false;
  view.dispatch({ changes: { from: line.from, insert: '\n' }, selection: EditorSelection.cursor(pos + 1), scrollIntoView: true, userEvent: 'input' });
  return true;
};

// ---------- deletion ----------

function joinTarget(view: EditorView, lineEnd: number): number {
  // At a line end, Delete joins the next line's text, without that line's hidden block markup.
  const zone = layoutAt(view, lineEnd + 1).zones.find((z) => z.from === lineEnd + 1);
  return zone ? zone.to : lineEnd + 1;
}

/**
 * Backspace and Delete next to hidden inline markup delete the letter beyond it, never a marker
 * (DESIGN §6.6.1). After Backspace at the end of bold text, the cursor stays inside the bold;
 * after a link, it stays after the link. Formatting left without text is removed by
 * `removeEmptyFormatting`.
 */
function deleteAcrossMarkup(forward: boolean, by: 'char' | 'group'): Command {
  return (view) => {
    const pos = editableCursor(view);
    if (pos === null) return false;
    const { state } = view;
    const line = state.doc.lineAt(pos);
    const layout = layoutAt(view, pos);
    if (forward) {
      const run = layout.runs.find((r) => r.from === pos && r.to > pos);
      if (!run) {
        // An empty line just goes, and the next line keeps its markup (a heading stays a heading).
        if (pos !== line.to || line.number === state.doc.lines || line.text.trim() === '') return false;
        const to = joinTarget(view, line.to);
        if (to === pos + 1) return false;
        view.dispatch({ changes: { from: pos, to }, selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'delete.forward' });
        return true;
      }
      const at = run.to;
      if (at === state.doc.length) return true;
      const to = at === line.to ? joinTarget(view, line.to) : by === 'group' ? view.moveByGroup(EditorSelection.cursor(at), true).head : line.from + findClusterBreak(line.text, at - line.from, true);
      if (to <= at) return true;
      view.dispatch({ changes: { from: at, to }, selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'delete.forward' });
      return true;
    }
    const run = layout.runs.find((r) => r.to === pos && r.from < pos);
    if (!run) return false;
    const at = run.from;
    if (at === line.from || layout.zones.some((z) => z.to === at)) {
      // Nothing to delete on this line before the markup: Backspace acts where the text starts
      // (removes block markup, or joins the line to the one before).
      view.dispatch({ selection: EditorSelection.cursor(at) });
      return deleteMarkupBackward(view) || deleteCharBackward(view) || true;
    }
    const from = by === 'group' ? view.moveByGroup(EditorSelection.cursor(at), false).head : line.from + findClusterBreak(line.text, at - line.from, false);
    if (from >= at) return true;
    // Typing continues the formatting the deleted letter had; after a link or code it stays outside.
    const inside = run.pieces[0].role === 'close';
    const cursor = inside ? from : pos - (at - from);
    view.dispatch({ changes: { from, to: at }, selection: EditorSelection.cursor(cursor, inside ? -1 : 1), scrollIntoView: true, userEvent: 'delete.backward' });
    return true;
  };
}

/**
 * A deletion that removes all the text of inline formatting or a link also removes its hidden
 * markers, so `**bold**` never turns into `****` (which Markdown reads as a rule or as text).
 */
const removeEmptyFormatting = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('delete')) return tr;
  const config = tr.startState.facet(livePreviewConfig);
  if (!config || config.locked || config.visibility !== 'hide-all') return tr;
  const removed: Array<{ from: number; to: number }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length > 0 || toA <= fromA) return;
    // Innermost first: `***b***` empties the bold, and then the italic around it.
    const elements = collectElements(tr.startState, [{ from: fromA, to: toA }])
      .filter((el) => INLINE_KINDS.has(el.kind))
      .sort((a, b) => a.to - a.from - (b.to - b.from));
    const gone = [{ from: fromA, to: toA }];
    for (const el of elements) {
      if (covered(gone, el.from, el.to) || !covered(gone, el.textFrom, el.textTo)) continue;
      gone.push({ from: el.from, to: el.to });
      removed.push({ from: tr.changes.mapPos(el.from, 1), to: tr.changes.mapPos(el.to, -1) });
    }
  });
  const changes = merge(removed);
  return changes.length ? [tr, { changes, sequential: true }] : tr;
});

function merge(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else if (r.to > r.from) out.push({ ...r });
  }
  return out;
}

/** Whether `ranges` together cover `from`..`to`. */
function covered(ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean {
  let pos = from;
  for (const r of merge(ranges)) {
    if (r.from > pos) break;
    pos = Math.max(pos, r.to);
  }
  return pos >= to;
}

const liveKeymap = Prec.highest(
  keymap.of([
    { key: 'Backspace', run: deleteAcrossMarkup(false, 'char') },
    { key: 'Delete', run: deleteAcrossMarkup(true, 'char') },
    { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: deleteAcrossMarkup(false, 'group') },
    { key: 'Mod-Delete', mac: 'Alt-Delete', run: deleteAcrossMarkup(true, 'group') },
    { key: 'ArrowLeft', run: leftOverPrefix },
    { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: leftOverPrefix },
    { key: 'Enter', run: newLineAboveHeading },
  ]),
);

// ---------- links ----------

let lastPointerType = 'mouse';

/** The rendered link or tag an event happened on, if any. */
function linkElement(view: EditorView, target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('.cm-lp-link, .cm-hashtag') : null;
  return el && view.contentDOM.contains(el) ? el : null;
}

/**
 * Rendered links follow on a tap, on a click while the note is locked, or on Mod-click while
 * editing (a plain click places the caret, to edit the link's text).
 */
const linkClicks = EditorView.domEventHandlers({
  pointerdown(event) {
    lastPointerType = event.pointerType || 'mouse';
    return false;
  },
  mousedown(event, view) {
    // A tap on a link while editing keeps the caret where it is (and the keyboard closed).
    if (lastPointerType !== 'touch' || !view.state.facet(EditorView.editable) || !linkElement(view, event.target)) return false;
    event.preventDefault();
    return true;
  },
  click(event, view) {
    if (event.button !== 0) return false;
    const el = linkElement(view, event.target);
    if (!el) return false;
    const editable = view.state.facet(EditorView.editable);
    const mod = modKey(event);
    if (editable && !mod && lastPointerType !== 'touch') return false;
    // A drag that selected text in a locked note ends with a click; it is not a link tap.
    if (!editable && !mod && !view.state.selection.main.empty) return false;
    const hit = linkAt(view.state, view.posAtDOM(el));
    if (!hit) return false;
    event.preventDefault();
    return followLink(view, hit);
  },
});

/**
 * Live Preview of inline content and lines, without tables: the note's editor uses it, and so does
 * the editor of a table cell, which holds one line of inline Markdown.
 */
export function livePreviewInline(config: LivePreviewConfig): Extension {
  return [
    livePreviewConfig.of(config),
    livePlugin,
    EditorView.atomicRanges.of((view) => view.plugin(livePlugin)?.live.atomic ?? RangeSet.empty),
    EditorView.editorAttributes.of({ class: config.locked ? 'cm-live-preview cm-lp-locked' : 'cm-live-preview' }),
    Prec.high(linkClicks),
    touchTracking,
    config.locked ? EditorView.contentAttributes.of({ tabindex: '0' }) : [settleSelection, removeEmptyFormatting, liveKeymap],
    // The selection toolbar on desktop; phones have the keyboard toolbar and the system's selection menu.
    config.locked || isIOS || isCoarsePointer() ? [] : formatToolbar(),
  ];
}

/**
 * The Live Preview extension (DESIGN §6.6.1). `locked` renders the same way read-only: the note
 * gets keyboard focus for reading, and links follow on a plain click. Tables come first, so their
 * keys (arrows and deletion next to a table) run before the inline ones. The typing shortcuts
 * (inputRules.ts) apply to the note's lines, not in a table cell.
 */
export function livePreview(config: LivePreviewConfig): Extension {
  return [
    liveBlocks({ locked: config.locked, hideComments: config.locked || config.visibility === 'hide-all' }),
    tables({ locked: config.locked, remoteImages: config.remoteImages }),
    livePreviewInline(config),
    footnoteTooltips(),
    config.locked ? [] : inputRules(),
  ];
}
