// Live Preview blocks (DESIGN §6.6.1, ROADMAP 10b): the note's frontmatter shows as its
// properties, and comment blocks (`%%` lines) are hidden, in hide-all and in locked mode. Both are
// block widgets over whole lines, from editor state (they hide line breaks). The caret never rests
// in or against a block (a move that lands there goes past it), typing next to one never puts text
// inside it, and Backspace or Delete never joins a line to it.
//
// Editing them: the properties have an edit button (and ArrowUp from the line under them goes in),
// which shows the frontmatter's YAML as text; a comment block shows while you type in it (as you
// close it) or a search selects text in it. Either goes back to a block when the caret leaves it.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Facet, Prec, RangeSet, RangeValue, StateEffect, StateField, Transaction, type ChangeDesc, type Extension, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type Command, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { noteContext, vaultChanged } from '../context';
import { textReplace } from '../remote';
import { remeasureOnChange } from './embeds';
import { isPointerSelection } from './pointer';
import { tableEdit } from './table/facets';
import { parsedPast, topLevel, wholeLines } from './topLevel';

export interface HiddenBlock {
  kind: 'properties' | 'comment';
  /** The start of the block's first line, and the end of its last. */
  from: number;
  to: number;
  /** A comment block's node, to know it again after an edit. */
  node?: { from: number; to: number };
}

/** The note's frontmatter: its block and its YAML (between the start of its second line and the start of its closing line). */
interface Frontmatter {
  block: HiddenBlock;
  yamlFrom: number;
  yamlTo: number;
}

interface Blocks {
  frontmatter: Frontmatter | null;
  /** The blocks that show as a widget unless being edited, in document order. */
  candidates: readonly HiddenBlock[];
  /** The block shown as text while you edit it (the properties' YAML, a comment you are typing). */
  editing: { from: number; to: number } | null;
  decorations: DecorationSet;
  atomic: RangeSet<RangeValue>;
}

export interface BlocksConfig {
  /** A locked note: the properties have no edit button, and unclosed comments hide too (as in the reading of the note). */
  locked: boolean;
  /** Comment blocks hide (hide-all, and locked); in reveal-at-cursor mode they show, dimmed. */
  hideComments: boolean;
}

const blocksConfig = Facet.define<BlocksConfig, BlocksConfig>({
  combine: (values) => values[0] ?? { locked: false, hideComments: true },
});

/** Shows (true) the properties' YAML for editing, or the properties block again (false). */
export const editProperties = StateEffect.define<boolean>();

class Atom extends RangeValue {}
const atom = new Atom();

// ---------- widgets ----------

const cleanups = new WeakMap<HTMLElement, () => void>();

/** What a properties widget's DOM shows, so new YAML can be shown in place (`updateDOM`). */
interface ShownProperties {
  editable: boolean;
  source: string;
  update: ((yaml: string) => void) | null;
}

const shownProperties = new WeakMap<HTMLElement, ShownProperties>();

/** The note's properties, drawn by the app (`NoteContext.renderProperties`). */
class PropertiesWidget extends WidgetType {
  readonly yaml: string;
  readonly editable: boolean;
  /** The note's path: its links resolve from there, so a move of the note draws them again. */
  readonly source: string;
  constructor(yaml: string, editable: boolean, source: string) {
    super();
    this.yaml = yaml;
    this.editable = editable;
    this.source = source;
  }
  override eq(other: PropertiesWidget): boolean {
    return other.yaml === this.yaml && other.editable === this.editable && other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-lp-properties';
    const note = view.state.facet(noteContext);
    const shown = note
      ? note.renderProperties(el, this.yaml, this.editable ? () => startEditingProperties(view) : null, this.editable ? (edit) => applyPropertiesEdit(view, edit) : null)
      : () => {};
    if (!note) el.textContent = 'Properties';
    const unmount = typeof shown === 'function' ? shown : () => shown.destroy();
    shownProperties.set(el, { editable: this.editable, source: this.source, update: typeof shown === 'function' ? null : (yaml) => shown.update(yaml) });
    const unmeasure = remeasureOnChange(view, el);
    cleanups.set(el, () => {
      unmeasure();
      unmount();
    });
    return el;
  }
  /** New YAML for the same note and mode is shown in place: a field being edited keeps its focus. */
  override updateDOM(dom: HTMLElement): boolean {
    const shown = shownProperties.get(dom);
    if (!shown?.update || shown.editable !== this.editable || shown.source !== this.source) return false;
    shown.update(this.yaml);
    return true;
  }
  override destroy(dom: HTMLElement): void {
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override get estimatedHeight(): number {
    return 44 + 32 * this.yaml.split('\n').filter((l) => /^\S/.test(l)).length;
  }
}

/** A hidden comment block: nothing to see. */
class HiddenCommentWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-lp-hidden-comment';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override get estimatedHeight(): number {
    return 0;
  }
}

const hiddenComment = new HiddenCommentWidget();

// ---------- finding the blocks ----------

function frontmatterOf(state: EditorState): Frontmatter | null {
  const node = syntaxTree(state).topNode.firstChild;
  if (!node || node.name !== 'Frontmatter') return null;
  const dashes = node.getChildren('DashLine');
  if (dashes.length < 2) return null;
  const open = dashes[0];
  const close = dashes[dashes.length - 1];
  return { block: { kind: 'properties', from: 0, to: state.doc.lineAt(close.from).to }, yamlFrom: open.to, yamlTo: close.from };
}

/** The note's top-level comment blocks: closed ones while editing, every one in a locked note. */
function commentBlocks(state: EditorState, config: BlocksConfig, previous: Blocks | null, changes: ChangeDesc | null): HiddenBlock[] {
  if (!config.hideComments) return [];
  // A block the edit did not touch is known again by its node, without reading its lines again.
  const kept = new Map<number, HiddenBlock>();
  for (const b of previous?.candidates ?? []) {
    if (!b.node || (changes && !changes.empty && changes.touchesRange(b.from, b.to))) continue;
    if (!changes || changes.empty) kept.set(b.node.from, b);
    else kept.set(changes.mapPos(b.node.from), { kind: 'comment', from: changes.mapPos(b.from), to: changes.mapPos(b.to), node: { from: changes.mapPos(b.node.from), to: changes.mapPos(b.node.to) } });
  }
  const out: HiddenBlock[] = [];
  const top = topLevel(state);
  for (const node of top.comments) {
    // An unclosed `%%` runs to the end of the note: while you write, it stays text (dimmed).
    if (!config.locked && !node.closed) continue;
    const same = kept.get(node.from);
    if (same && same.node!.to === node.to) {
      out.push(same);
      continue;
    }
    const lines = wholeLines(state, node);
    if (lines) out.push({ kind: 'comment', ...lines, node: { from: node.from, to: node.to } });
  }
  // Where the parse has not caught up with an edit yet, a block keeps its place (mapped through the
  // edit) while its lines still start and end it, so it never blinks out.
  if (previous && changes) {
    for (const b of previous.candidates) {
      if (b.kind !== 'comment') continue;
      const from = changes.mapPos(b.from, 1);
      const to = changes.mapPos(b.to, -1);
      if (from < top.lastFrom || to <= from || parsedPast(state, to) || out.some((o) => o.from <= to && o.to >= from)) continue;
      const first = state.doc.lineAt(from);
      if (first.from === from && state.doc.lineAt(to).to === to && first.text.startsWith('%%')) out.push({ kind: 'comment', from, to });
    }
    out.sort((a, b) => a.from - b.from);
  }
  return out;
}

/** Whether a transaction is your edit (or a search) that leaves the cursor in a block it should show as text. */
function entersByEditing(tr: Transaction): boolean {
  if (tr.isUserEvent('select.search')) return true;
  if (!tr.docChanged || tr.annotation(Transaction.remote)) return false;
  return tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.isUserEvent('move');
}

/** Whether the blocks are those of `value`, moved by `changes` but none of them touched, and the same one is edited. */
function unchanged(value: Blocks, changes: ChangeDesc, candidates: readonly HiddenBlock[], editing: Blocks['editing']): boolean {
  if (candidates.length !== value.candidates.length || (editing === null) !== (value.editing === null)) return false;
  if (editing && value.editing && (editing.from !== changes.mapPos(value.editing.from) || editing.to !== changes.mapPos(value.editing.to))) return false;
  return candidates.every((c, i) => {
    const old = value.candidates[i];
    return c.kind === old.kind && !(!changes.empty && changes.touchesRange(old.from, old.to)) && c.from === changes.mapPos(old.from) && c.to === changes.mapPos(old.to);
  });
}

function build(state: EditorState, frontmatter: Frontmatter | null, candidates: readonly HiddenBlock[], editing: Blocks['editing']): Blocks {
  const config = state.facet(blocksConfig);
  const editable = !config.locked && !state.readOnly;
  const shown = candidates.filter((b) => !editing || b.from !== editing.from);
  const decorations = Decoration.set(
    shown.map((b) => {
      const widget = b.kind === 'properties' && frontmatter ? new PropertiesWidget(state.sliceDoc(frontmatter.yamlFrom, frontmatter.yamlTo), editable, state.facet(noteContext)?.path() ?? '') : hiddenComment;
      return Decoration.replace({ widget, block: true }).range(b.from, b.to);
    }),
  );
  return { frontmatter, candidates, editing, decorations, atomic: RangeSet.of(shown.map((b) => atom.range(b.from, b.to))) };
}

const blocksField = StateField.define<Blocks>({
  create(state) {
    const frontmatter = frontmatterOf(state);
    const candidates = [...(frontmatter ? [frontmatter.block] : []), ...commentBlocks(state, state.facet(blocksConfig), null, null)];
    return build(state, frontmatter, candidates, null);
  },
  update(value, tr) {
    const config = tr.state.facet(blocksConfig);
    // A mode switch keeps the field's value (the editor's state is reconfigured): it is computed again.
    // So is a change of the vault (the note moved: the properties' links resolve from its new place).
    const reconfigured = config !== tr.startState.facet(blocksConfig) || tr.state.readOnly !== tr.startState.readOnly || tr.effects.some((e) => e.is(vaultChanged));
    let { frontmatter, candidates } = value;
    if (reconfigured || tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      frontmatter = frontmatterOf(tr.state);
      candidates = [...(frontmatter ? [frontmatter.block] : []), ...commentBlocks(tr.state, config, value, tr.docChanged ? tr.changes : null)];
    }
    const editable = !config.locked && !tr.state.readOnly;
    let editing = !editable ? null : value.editing && tr.docChanged ? { from: tr.changes.mapPos(value.editing.from, 1), to: tr.changes.mapPos(value.editing.to, -1) } : value.editing;
    for (const e of tr.effects) if (e.is(editProperties)) editing = e.value && frontmatter && editable ? { from: frontmatter.block.from, to: frontmatter.block.to } : null;
    const head = tr.state.selection.main.head;
    const holding = (b: HiddenBlock) => head >= b.from && head <= b.to;
    if (editing) {
      // Still the block you are in? It may have grown or shrunk with your edit.
      const was = editing;
      const b = candidates.find((c) => c.from <= was.to && c.to >= was.from);
      editing = b && holding(b) ? { from: b.from, to: b.to } : null;
    }
    if (!editing && editable && entersByEditing(tr)) {
      const b = candidates.find(holding);
      if (b) editing = { from: b.from, to: b.to };
    }
    if (!reconfigured && unchanged(value, tr.changes, candidates, editing)) {
      // Only positions moved (ROADMAP 10c: a keystroke in a long note builds no new widgets).
      if (!tr.docChanged && candidates === value.candidates && editing === value.editing) return value;
      return { frontmatter, candidates, editing, decorations: value.decorations.map(tr.changes), atomic: value.atomic.map(tr.changes) };
    }
    return build(tr.state, frontmatter, candidates, editing);
  },
  provide: (field) => [EditorView.decorations.from(field, (b) => b.decorations), EditorView.atomicRanges.of((view) => view.state.field(field).atomic)],
});

/** The blocks shown as a widget: the caret goes around them. */
export function shownBlocks(state: EditorState): readonly HiddenBlock[] {
  const value = state.field(blocksField, false);
  if (!value) return [];
  return value.editing ? value.candidates.filter((b) => b.from !== value.editing!.from) : value.candidates;
}

/** Whether the properties show as text for editing. */
export function editingProperties(state: EditorState): boolean {
  const value = state.field(blocksField, false);
  return !!value?.frontmatter && value.editing?.from === value.frontmatter.block.from;
}

// ---------- editing the properties ----------

/** The transaction that shows the properties' YAML with the caret at its end (an empty frontmatter gets a line to type on). */
function editingSpec(state: EditorState): TransactionSpec | null {
  const fm = state.field(blocksField, false)?.frontmatter;
  if (!fm || state.readOnly) return null;
  const effects = editProperties.of(true);
  if (fm.yamlTo > fm.yamlFrom) return { selection: EditorSelection.cursor(fm.yamlTo - 1), effects, scrollIntoView: true, userEvent: 'select' };
  return { changes: { from: fm.yamlFrom, insert: '\n' }, selection: EditorSelection.cursor(fm.yamlFrom), effects, scrollIntoView: true, userEvent: 'input' };
}

/**
 * A typed edit of the properties (ROADMAP 13): `edit` maps the frontmatter's current YAML to the
 * new YAML, and only what differs is replaced, as one undoable edit. It is not an `input` event,
 * so the properties stay a block (the caret does not go into the YAML). Throws what `edit` throws.
 */
export function applyPropertiesEdit(view: EditorView, edit: (yaml: string) => string): boolean {
  const fm = view.state.field(blocksField, false)?.frontmatter;
  if (!fm || view.state.readOnly) return false;
  const yaml = view.state.sliceDoc(fm.yamlFrom, fm.yamlTo);
  const next = edit(yaml);
  if (next === yaml) return true;
  let start = 0;
  while (start < yaml.length && start < next.length && yaml[start] === next[start]) start++;
  let end = 0;
  while (end < yaml.length - start && end < next.length - start && yaml[yaml.length - 1 - end] === next[next.length - 1 - end]) end++;
  view.dispatch({
    changes: { from: fm.yamlFrom + start, to: fm.yamlTo - end, insert: next.slice(start, next.length - end) },
    userEvent: 'properties.edit',
  });
  return true;
}

/** The properties' edit button: shows their YAML as text, with the caret at its end. */
export function startEditingProperties(view: EditorView): boolean {
  const spec = editingSpec(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  view.focus();
  return true;
}

// ---------- the caret around blocks ----------

/**
 * The caret never rests in or against a block: a move that lands there goes past it, the way it
 * was heading (a click: to the nearer side). From the line under the properties, a move up or left
 * goes into them (their YAML shows); a jump (Mod-Home) stops on the line under them. When the
 * properties end the note, your move past them gets an empty line there to type on.
 */
const settleAroundBlocks = EditorState.transactionFilter.of((tr) => {
  const selection = tr.selection;
  if (tr.docChanged || !selection || tr.annotation(tableEdit) !== undefined || tr.effects.some((e) => e.is(editProperties))) return tr;
  const blocks = shownBlocks(tr.startState);
  if (blocks.length === 0) return tr;
  const { doc } = tr.startState;
  const old = tr.startState.selection.main.head;
  const pointer = isPointerSelection(tr);
  const editable = !tr.startState.facet(blocksConfig).locked && !tr.startState.readOnly;
  const blockAt = (pos: number) => blocks.find((x) => pos >= x.from && pos <= x.to);
  /** Past the blocks at `pos` (adjacent ones too) the way `side` goes; null at the note's edge. */
  const past = (pos: number, side: 'before' | 'after'): number | null => {
    for (let b = blockAt(pos); b; b = blockAt(pos)) {
      pos = side === 'after' ? b.to + 1 : b.from - 1;
      if (pos < 0 || pos > doc.length) return null;
    }
    return pos;
  };
  let changed = false;
  let replace: TransactionSpec | null = null;
  const ranges = selection.ranges.map((r, i): SelectionRange => {
    const b = r.empty ? blockAt(r.head) : undefined;
    if (!b) return r;
    const nearest = r.head - b.from <= b.to - r.head ? 'before' : 'after';
    let side: 'before' | 'after' = pointer ? nearest : old < b.from ? 'after' : old > b.to ? 'before' : nearest;
    if (b.kind === 'properties') {
      const fromBelow = old > b.to && doc.lineAt(old).number === doc.lineAt(b.to).number + 1;
      if (editable && !pointer && fromBelow && i === selection.mainIndex) {
        replace = editingSpec(tr.startState);
        return r;
      }
      // Nothing comes before the properties.
      side = 'after';
    }
    const pos = past(r.head, side) ?? past(r.head, side === 'after' ? 'before' : 'after');
    if (pos !== null) {
      changed = true;
      return EditorSelection.cursor(pos);
    }
    // Properties that end the note: your move past them gets a line to type on.
    const last = blocks[blocks.length - 1];
    if (editable && last.to === doc.length && tr.isUserEvent('select') && i === selection.mainIndex) {
      replace = { changes: { from: last.to, insert: '\n' }, selection: EditorSelection.cursor(last.to + 1), scrollIntoView: true, userEvent: 'input' };
    }
    return r;
  });
  if (replace) return replace;
  return changed ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }] : tr;
});

/**
 * Typing where the caret should not be (against or in a block, as a note opens with the caret at
 * its start) never puts text inside the block: it goes on the line under the properties, or on a
 * line of its own before or after a comment block.
 */
const guardBlockEdges = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input') || tr.annotation(tableEdit) !== undefined || tr.annotation(textReplace) || tr.effects.some((e) => e.is(editProperties))) return tr;
  const blocks = shownBlocks(tr.startState);
  if (blocks.length === 0) return tr;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
  if (changes.length !== 1) return tr;
  const [{ from, to, insert }] = changes;
  if (from !== to || insert === '') return tr;
  const b = blocks.find((x) => from >= x.from && from <= x.to);
  // A line break at a comment block's edge, or after the properties, keeps it whole.
  if (!b || (insert === '\n' && (b.kind === 'comment' ? from === b.from || from === b.to : from === b.to))) return tr;
  const length = tr.startState.doc.length;
  let at: number;
  let text: string;
  if (b.kind === 'comment' && from === b.from) {
    at = b.from;
    text = insert.endsWith('\n') ? insert : insert + '\n';
  } else if (b.kind === 'properties' && b.to < length) {
    at = b.to + 1;
    text = insert;
  } else {
    at = b.to;
    text = insert.startsWith('\n') ? insert : '\n' + insert;
  }
  const caret = at + (b.kind === 'comment' && from === b.from ? insert.length : text.length);
  return { changes: { from: at, insert: text }, selection: EditorSelection.cursor(caret), scrollIntoView: true, userEvent: tr.annotation(Transaction.userEvent) ?? 'input' };
});

/**
 * Backspace at the start of the line under a block, and Delete at the end of the line above one,
 * would join that line to it (hiding the line in a comment, or breaking the frontmatter): the
 * caret moves past the block instead. An empty line next to a block is deleted from its other
 * side, so the caret never ends up against (or in) the block.
 */
export function deleteNextToBlock(forward: boolean): Command {
  return (view) => {
    const { state } = view;
    const { selection } = state;
    if (state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return false;
    const blocks = shownBlocks(state);
    if (blocks.length === 0) return false;
    const pos = selection.main.head;
    // The caret never rests in a block; if it does (as a note opens), nothing of the block is deleted.
    if (blocks.some((b) => pos >= b.from && pos <= b.to)) return true;
    const b = blocks.find((x) => (forward ? pos === x.from - 1 : pos === x.to + 1));
    if (!b) return false;
    const { length } = state.doc;
    const before = b.from > 0 ? b.from - 1 : null;
    if (state.doc.lineAt(pos).length === 0) {
      let changes: { from: number; to: number };
      let caret: number;
      if (!forward) {
        // Its own line break goes (or, as the last line, the one before it); the caret goes above the block.
        changes = pos < length ? { from: pos, to: pos + 1 } : { from: pos - 1, to: pos };
        caret = before ?? (pos < length ? pos : b.to);
      } else if (pos > 0) {
        changes = { from: pos - 1, to: pos };
        caret = pos - 1;
      } else {
        // An empty first line above a block: the caret goes under the block.
        changes = { from: 0, to: 1 };
        caret = b.to < length ? b.to : 0;
      }
      view.dispatch({ changes, selection: EditorSelection.cursor(caret), scrollIntoView: true, userEvent: forward ? 'delete.forward' : 'delete.backward' });
      return true;
    }
    const target = forward ? (b.to < length ? b.to + 1 : null) : before;
    if (target !== null) view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

const blockKeymap = keymap.of([
  ...['Backspace', 'Shift-Backspace', 'Mod-Backspace', 'Alt-Backspace'].map((key) => ({ key, run: deleteNextToBlock(false) })),
  ...['Delete', 'Mod-Delete', 'Alt-Delete'].map((key) => ({ key, run: deleteNextToBlock(true) })),
]);

/** A note that opens with the caret in a block (at its start, say): focusing it moves the caret out. */
const settleOnFocus = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.focusChanged || !update.view.hasFocus) return;
      const view = update.view;
      const head = (s: EditorState) => s.selection.main;
      const inBlock = (s: EditorState) => head(s).empty && shownBlocks(s).some((b) => head(s).head >= b.from && head(s).head <= b.to && (b.kind !== 'properties' || b.to < s.doc.length));
      if (!inBlock(view.state)) return;
      // Not during the update; the settle filter takes it from here.
      queueMicrotask(() => {
        if (view.hasFocus && inBlock(view.state)) view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.head), userEvent: 'select' });
      });
    }
  },
);

/** The properties block and hidden comment blocks of Live Preview, and in an editable note the caret rules around them. */
export function liveBlocks(config: BlocksConfig): Extension {
  return [blocksConfig.of(config), blocksField, config.locked ? [] : [settleAroundBlocks, guardBlockEdges, settleOnFocus, Prec.highest(blockKeymap)]];
}

/** Whether the properties show as a block in this editor (Live Preview, editable or locked). */
export function hasPropertiesBlock(state: EditorState): boolean {
  return state.field(blocksField, false) !== undefined;
}
