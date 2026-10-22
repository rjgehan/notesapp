// Live Preview's rich Markdown (ROADMAP items 3 and 10, DESIGN §6.6.1): callouts, `$$` math blocks
// and Mermaid diagrams show rendered, as the reading of the note always showed them, and `$x$`
// shows as typeset math. The rendering is the app's (`NoteContext.renderMarkdown` and `renderMath`:
// markdown-it with the rich pack, KaTeX and Mermaid), so a block looks the same in Live Preview,
// in a locked note and in a transcluded note. Highlighted code needs nothing here: the editor
// highlights fenced code itself, with the same tokens.
//
// In a locked note the blocks always show rendered. While editing, a block or a formula shows as
// text while the selection touches it (a click on it puts the caret at its start), and rendered
// again once the caret leaves, as Obsidian does.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, Facet, Prec, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { noteContext, vaultChanged } from '../context';
import { remeasureOnChange } from './embeds';
import { revealSource } from './reveal';
import { topLevel, wholeLines, type RichKind } from './topLevel';

export interface RichConfig {
  /** A locked note: the blocks never show as text. */
  locked: boolean;
  /** Images from other sites load in rendered blocks. */
  remoteImages: boolean;
  /** Task checkboxes in rendered blocks can be toggled. */
  checkboxes: boolean;
}

const richConfig = Facet.define<RichConfig, RichConfig>({
  combine: (values) => values[0] ?? { locked: false, remoteImages: true, checkboxes: false },
});

/** A task line's checkbox (as the reading view's TASK_PATTERN): the character between its brackets. */
const TASK = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])\]/;

/** Whether the note's text can be changed here (not locked, not read-only). */
function editable(state: EditorState): boolean {
  return !state.facet(richConfig).locked && !state.readOnly;
}

/** Whether a selection range touches `from`..`to` (its edges included): the text shows there. */
function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

// ---------- blocks ----------

const cleanups = new WeakMap<HTMLElement, () => void>();

/** Toggles the task on line `line` of the block whose widget is `el`. */
function toggleTaskIn(view: EditorView, el: HTMLElement, line: number): boolean {
  if (!editableForTasks(view)) return false;
  const { doc } = view.state;
  const first = doc.lineAt(view.posAtDOM(el)).number;
  const n = first + line;
  if (n < 1 || n > doc.lines) return false;
  const text = doc.line(n);
  const m = TASK.exec(text.text);
  if (!m) return false;
  const at = text.from + m[1].length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
  return true;
}

function editableForTasks(view: EditorView): boolean {
  return view.state.facet(richConfig).checkboxes;
}

class RichBlockWidget extends WidgetType {
  readonly kind: RichKind;
  readonly source: string;
  readonly config: RichConfig;
  /** The note's path: links resolve from it, so a move of the note draws the block again. */
  readonly path: string;
  constructor(kind: RichKind, source: string, config: RichConfig, path: string) {
    super();
    this.kind = kind;
    this.source = source;
    this.config = config;
    this.path = path;
  }
  override eq(other: RichBlockWidget): boolean {
    return (
      other.kind === this.kind &&
      other.source === this.source &&
      other.path === this.path &&
      other.config.locked === this.config.locked &&
      other.config.remoteImages === this.config.remoteImages &&
      other.config.checkboxes === this.config.checkboxes
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = `cm-lp-rich cm-lp-rich-${this.kind}`;
    const note = view.state.facet(noteContext);
    const unmount = note?.renderMarkdown
      ? note.renderMarkdown(el, {
          source: this.source,
          remoteImages: this.config.remoteImages,
          checkboxes: this.config.checkboxes,
          toggleTask: (line) => toggleTaskIn(view, el, line),
        })
      : () => {};
    const unmeasure = remeasureOnChange(view, el);
    // While editing, a click on the block (not on a link, a checkbox or a fold) shows its text,
    // with the caret at its start.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !editable(view.state)) return;
      if (e.target instanceof Element && e.target.closest('a, input, button, summary, .callout-fold, [data-embed-root]')) return;
      e.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(el)), scrollIntoView: false, userEvent: 'select.pointer' });
      view.focus();
    };
    el.addEventListener('mousedown', onDown);
    cleanups.set(el, () => {
      el.removeEventListener('mousedown', onDown);
      unmeasure();
      unmount();
    });
    return el;
  }
  override destroy(dom: HTMLElement): void {
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }
  override ignoreEvent(): boolean {
    // The rendered block takes its own clicks (links, checkboxes, folds), and selects text in it.
    return true;
  }
  override get estimatedHeight(): number {
    const lines = this.source.split('\n').length;
    return this.kind === 'mermaid' ? 240 : 26 * lines + 16;
  }
}

interface RichBlock {
  kind: RichKind;
  from: number;
  to: number;
}

interface RichBlocks {
  blocks: readonly RichBlock[];
  decorations: DecorationSet;
}

function findBlocks(state: EditorState): RichBlock[] {
  const out: RichBlock[] = [];
  for (const b of topLevel(state).rich) {
    const lines = wholeLines(state, b);
    if (lines && b.rich) out.push({ kind: b.rich, ...lines });
  }
  return out;
}

function decorate(state: EditorState, blocks: readonly RichBlock[]): DecorationSet {
  const note = state.facet(noteContext);
  if (!note?.renderMarkdown) return Decoration.none;
  const config = state.facet(richConfig);
  const reveal = editable(state);
  const path = note.path();
  const ranges: Range<Decoration>[] = [];
  for (const b of blocks) {
    if (reveal && touches(state, b.from, b.to)) continue;
    const widget = new RichBlockWidget(b.kind, state.sliceDoc(b.from, b.to), config, path);
    ranges.push(Decoration.replace({ widget, block: true }).range(b.from, b.to));
  }
  return Decoration.set(ranges);
}

const richBlocksField = StateField.define<RichBlocks>({
  create(state) {
    const blocks = findBlocks(state);
    return { blocks, decorations: decorate(state, blocks) };
  },
  update(value, tr) {
    const reconfigured =
      tr.startState.facet(richConfig) !== tr.state.facet(richConfig) || tr.startState.readOnly !== tr.state.readOnly || tr.effects.some((e) => e.is(vaultChanged));
    const reparsed = tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!reconfigured && !reparsed && !tr.selection) return value;
    const blocks = reparsed || reconfigured ? findBlocks(tr.state) : value.blocks;
    return { blocks, decorations: decorate(tr.state, blocks) };
  },
  // Above the inline Live Preview decorations (the quote markers of a callout's lines).
  provide: (field) => Prec.highest(EditorView.decorations.from(field, (v) => v.decorations)),
});

/** The rich blocks shown rendered (for tests and the caret rules of other extensions). */
export function renderedRichBlocks(state: EditorState): readonly RichBlock[] {
  const value = state.field(richBlocksField, false);
  if (!value) return [];
  const out: RichBlock[] = [];
  const iter = value.decorations.iter();
  for (; iter.value; iter.next()) {
    const b = value.blocks.find((x) => x.from === iter.from);
    if (b) out.push(b);
  }
  return out;
}

// ---------- inline math ----------

class MathWidget extends WidgetType {
  readonly tex: string;
  readonly display: boolean;
  constructor(tex: string, display: boolean) {
    super();
    this.tex = tex;
    this.display = display;
  }
  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = this.display ? 'cm-lp-math is-display' : 'cm-lp-math';
    const note = view.state.facet(noteContext);
    if (note?.renderMath) {
      note.renderMath(el, this.tex, this.display);
      // KaTeX loads lazily: the line's height may change once it has drawn.
      queueMicrotask(() => view.requestMeasure());
    } else {
      el.textContent = this.tex;
    }
    // A click puts the caret into the formula's TeX (after its opening `$` or `$$`), which then
    // shows as text (reveal.ts).
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !editable(view.state)) return;
      e.preventDefault();
      let from: number;
      try {
        from = view.posAtDOM(el);
      } catch {
        return;
      }
      revealSource(view, Math.min(from + (this.display ? 2 : 1), view.state.doc.length));
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function buildMath(view: EditorView): DecorationSet {
  const { state } = view;
  const note = state.facet(noteContext);
  if (!note?.renderMath) return Decoration.none;
  const reveal = editable(state);
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'BlockMath' || node.name === 'InlineCode' || node.name === 'Frontmatter') return false;
        if (node.name !== 'InlineMath') return;
        const marks = node.node.getChildren('InlineMathMark');
        if (marks.length < 2) return false;
        if (reveal && touches(state, node.from, node.to)) return false;
        const open = marks[0];
        const close = marks[marks.length - 1];
        const tex = state.sliceDoc(open.to, close.from);
        if (tex.trim() === '') return false;
        ranges.push(Decoration.replace({ widget: new MathWidget(tex, open.to - open.from === 2) }).range(node.from, node.to));
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

const mathPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMath(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.facet(richConfig) !== update.state.facet(richConfig)
      ) {
        this.decorations = buildMath(update.view);
      }
    }
  },
  { decorations: (p) => p.decorations },
);

/** Live Preview's rich blocks and inline math. */
export function richMarkdown(config: RichConfig): Extension {
  return [richConfig.of(config), richBlocksField, mathPlugin];
}
