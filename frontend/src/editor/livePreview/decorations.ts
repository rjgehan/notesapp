// Live Preview decorations (DESIGN §6.6.1): the model's elements as CodeMirror decorations for the
// visible ranges, plus the atomic ranges that make the cursor step over hidden markup.
import { RangeSet, type EditorSelection, type EditorState, type Range, RangeValue } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import type { SyntaxVisibility } from '../../state/prefs';
import type { NoteContext } from '../context';
import { showsInCell } from './embeds';
import { footnotesOf, type FootnoteIndex } from './footnotes';
import { collectElements, hiddenPieces, isRevealed, layoutOf, type RevealOptions } from './model';
import { widgetFor, type WidgetContext } from './widgets';

export interface LivePreviewConfig {
  visibility: SyntaxVisibility;
  /** Read-only Live Preview (the `locked` mode): links follow on a plain click, nothing is revealed. */
  locked: boolean;
  /** Task checkboxes can be toggled (false while the note cannot be written). */
  checkboxes: boolean;
  /** Images from other sites load as they show (the per-device preference); otherwise on a click. */
  remoteImages?: boolean;
}

export interface BuildContext extends LivePreviewConfig {
  selection: EditorSelection;
  /** The editor has focus: reveal-at-cursor shows markup only while you are in the note. */
  focused: boolean;
  /** Autocompletion is open. */
  completing: boolean;
  /** The app (link resolution, embeds); null in a plain editor. */
  note: NoteContext | null;
  /** The note's footnotes; read from the state by default. */
  footnotes?(): FootnoteIndex;
  /** A table cell's editor: it shows images, and other embeds and footnotes as typed (a cell holds a line of text). */
  inCell?: boolean;
}

export interface LivePreview {
  decorations: DecorationSet;
  /** Hidden markup and widgets, which the cursor steps over. */
  atomic: RangeSet<RangeValue>;
}

class Atom extends RangeValue {}
const atom = new Atom();

const hidden = Decoration.replace({});
const fenceLine = Decoration.line({ class: 'cm-lp-fence-line' });
const markCache = new Map<string, Decoration>();
function mark(className: string): Decoration {
  let d = markCache.get(className);
  if (!d) {
    d = Decoration.mark({ class: className });
    markCache.set(className, d);
  }
  return d;
}

export function revealOptions(ctx: Pick<BuildContext, 'visibility' | 'locked' | 'focused' | 'completing'>): RevealOptions {
  if (ctx.locked) return { atCursor: false, atSelectionEnds: false, completing: false, comments: false, codeAtCursor: false };
  const reveal = ctx.visibility === 'reveal-at-cursor';
  return { atCursor: reveal && ctx.focused, atSelectionEnds: true, completing: ctx.completing, comments: reveal, codeAtCursor: true };
}

/** Decorations and atomic ranges for `ranges` of `state` (the visible ranges in the editor). */
export function buildLivePreview(state: EditorState, ranges: readonly { from: number; to: number }[], ctx: BuildContext): LivePreview {
  const elements = collectElements(state, ranges).filter((el) => {
    if (!ctx.inCell) return true;
    const spec = el.pieces[0]?.widget;
    return el.kind === 'footnote' ? false : el.kind !== 'embed' || (spec?.type === 'embed' && showsInCell(spec.embed, ctx.note));
  });
  const options = revealOptions(ctx);
  const widgets: WidgetContext = { checkboxes: ctx.checkboxes, remoteImages: ctx.remoteImages ?? true, note: ctx.note, footnotes: ctx.footnotes ?? (() => footnotesOf(state)) };
  const decos: Range<Decoration>[] = [];
  for (const el of elements) {
    for (const m of el.marks) if (m.to > m.from) decos.push(mark(m.className).range(m.from, m.to));
    if (el.lineClass) decos.push(Decoration.line({ class: el.lineClass.className }).range(el.lineClass.at));
    if (isRevealed(el, ctx.selection, options)) {
      // A revealed embed shows its source, and the file still shows after it.
      const spec = el.pieces[0]?.widget;
      if (el.kind === 'embed' && spec) decos.push(Decoration.widget({ widget: widgetFor(spec, widgets), side: 1 }).range(el.to));
      continue;
    }
    for (const p of el.pieces) {
      if (p.to <= p.from) continue;
      decos.push((p.widget ? Decoration.replace({ widget: widgetFor(p.widget, widgets) }) : hidden).range(p.from, p.to));
      // A code block's hidden fences are slim lines.
      if (el.kind === 'codeblock') decos.push(fenceLine.range(state.doc.lineAt(p.from).from));
    }
    if (el.hangingIndent) {
      decos.push(Decoration.line({ class: 'cm-lp-indent', attributes: { style: `--lp-indent: ${el.hangingIndent.em}em` } }).range(el.hangingIndent.at));
    }
  }
  const layout = layoutOf(state, hiddenPieces(elements, ctx.selection, options));
  const atoms = [...layout.zones, ...layout.runs, ...layout.blocks].map((r) => atom.range(r.from, r.to));
  return { decorations: Decoration.set(decos, true), atomic: RangeSet.of(atoms, true) };
}
