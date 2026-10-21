// Formatting commands (DESIGN §6.6.1, ROADMAP 10a): bold, italic, strikethrough, highlight, inline
// code and links toggle on selections and at the cursor, and heading, list and quote commands change
// whole lines. Each writes ordinary Markdown. The formatting already there is read from the Live
// Preview model (the Lezer tree), so a toggle sees what the editor shows, in Live Preview and in
// source mode alike.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, Prec, StateEffect, StateField, Transaction, type ChangeSpec, type EditorState, type Extension, type SelectionRange, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type Command } from '@codemirror/view';
import { Tree, type SyntaxNode } from '@lezer/common';
import { splitWikiBody } from '../features/syntax';
import { toast } from '../state/toasts';
import { collectElements, type ElementKind, type LiveElement } from './livePreview/model';

export type InlineFormat = 'strong' | 'emphasis' | 'strikethrough' | 'highlight' | 'code';

/** The Markdown each format writes. */
export const FORMAT_MARKERS: Readonly<Record<InlineFormat, string>> = { strong: '**', emphasis: '*', strikethrough: '~~', highlight: '==', code: '`' };

/**
 * Inline elements a format never cuts into: code's text is not Markdown, a wikilink's or URL's text
 * is its target, a tag is one word, and embeds, footnotes and comments show whole (or not at all).
 */
const ATOMIC: ReadonlySet<ElementKind> = new Set(['code', 'wikilink', 'autolink', 'url', 'tag', 'embed', 'footnote', 'comment']);
/** Elements a format's range steps around when it crosses their edge, splitting in two (`*a **b*** **c**`). */
const NESTING: ReadonlySet<ElementKind> = new Set(['emphasis', 'strong', 'strikethrough', 'highlight', 'link']);
const LINKS: ReadonlySet<ElementKind> = new Set(['link', 'wikilink', 'autolink', 'url']);
/** Blocks whose lines formatting leaves alone. */
const RAW_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Frontmatter']);

interface Span {
  from: number;
  to: number;
}

const BLANK = /\s/;

function isBlankAt(state: EditorState, pos: number): boolean {
  return BLANK.test(state.sliceDoc(pos, pos + 1));
}

/** `from`..`to` without the blanks at either end. */
function trim(state: EditorState, from: number, to: number): Span {
  while (from < to && isBlankAt(state, from)) from++;
  while (to > from && isBlankAt(state, to - 1)) to--;
  return { from, to };
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** `span` without `gaps`. */
function subtract(span: Span, gaps: readonly Span[]): Span[] {
  let pieces = [span];
  for (const g of gaps) {
    pieces = pieces.flatMap((p) => {
      if (g.to <= p.from || g.from >= p.to) return [p];
      const out: Span[] = [];
      if (g.from > p.from) out.push({ from: p.from, to: g.from });
      if (g.to < p.to) out.push({ from: g.to, to: p.to });
      return out;
    });
  }
  return pieces;
}

// ---------- lines ----------

/**
 * Block markup at a line start that inline formatting stays out of: quotes, list markers and task
 * boxes, heading marks, a footnote definition's label.
 */
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}(?:[ \t]+|$))?(?:\[\^[^\]\s]+\]:[ \t]*)?/;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;

/** Lines that are markup, not text: a rule, a link reference definition. */
const MARKUP_LINES = new Set(['HorizontalRule', 'LinkReference']);

/**
 * The name of the raw block (code, frontmatter, …) or table the line at `pos` is in, or of the
 * markup the line is (a rule, a link reference, a setext heading's underline), if any.
 */
function blockAt(state: EditorState, pos: number, tree: Tree = syntaxTree(state)): string | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (RAW_BLOCKS.has(node.name) || node.name === 'Table' || MARKUP_LINES.has(node.name)) return node.name;
    if (node.name === 'HeaderMark' && node.parent?.name.startsWith('SetextHeading')) return 'SetextUnderline';
  }
  return null;
}

/**
 * The syntax tree parsed at least to `to`, or null when that takes too long. The state's own tree
 * may stop at the viewport (the rest is parsed in the background), and formatting a selection
 * that reaches past it must not take formatted text for plain text.
 */
function treeTo(state: EditorState, to: number): Tree | null {
  // The parse may be further along than the state's tree (it moves on between transactions).
  const tree = ensureSyntaxTree(state, to, 2000);
  if (tree) return tree;
  // No language (nothing to read), or the parse took too long.
  return syntaxTree(state) === Tree.empty ? Tree.empty : null;
}

/**
 * The parts of `from`..`to` that inline formatting can apply to: on each line, the text after its
 * block markup (in a table, each cell's text), without blanks at the ends. Code blocks,
 * frontmatter, comments and HTML blocks are left out.
 */
function textSegments(state: EditorState, from: number, to: number, tree: Tree = syntaxTree(state)): Span[] {
  const out: Span[] = [];
  const add = (a: number, b: number) => {
    const s = trim(state, Math.max(a, from), Math.min(b, to));
    if (s.to > s.from) out.push(s);
  };
  for (let pos = from; ; ) {
    const line = state.doc.lineAt(pos);
    const block = line.length > 0 ? blockAt(state, line.from, tree) : null;
    if (block === 'Table') {
      tree.iterate({
        from: line.from,
        to: line.to,
        enter(node) {
          if (node.name === 'TableCell') add(node.from, node.to);
          return node.name === 'TableCell' ? false : undefined;
        },
      });
    } else if (block === null) {
      const prefix = BLOCK_PREFIX.exec(line.text)?.[0] ?? '';
      const heading = /#[ \t]*$|#[ \t]/.test(prefix);
      const end = heading ? line.to - (HEADING_CLOSE.exec(line.text.slice(prefix.length))?.[0].length ?? 0) : line.to;
      add(line.from + prefix.length, end);
    }
    if (line.to >= to) break;
    pos = line.to + 1;
  }
  return out;
}

/** The Live Preview elements on the lines of `from`..`to`. */
function elementsAround(state: EditorState, from: number, to: number, tree: Tree = syntaxTree(state)): LiveElement[] {
  return collectElements(state, [{ from: state.doc.lineAt(from).from, to: state.doc.lineAt(to).to }], tree);
}

// ---------- inline formats ----------

/** The markers that make `text` inline code: one more backtick than its longest run, padded when it starts or ends with one. */
function codeMarkers(text: string): { open: string; close: string } {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return { open: fence + pad, close: pad + fence };
}

function markersFor(format: InlineFormat, text: string): { open: string; close: string } {
  return format === 'code' ? codeMarkers(text) : { open: FORMAT_MARKERS[format], close: FORMAT_MARKERS[format] };
}

/**
 * Spans (elements, selected text) by the lines they are on, so the ones around a span are found
 * without going through all of them: a whole long note can be selected and formatted.
 */
class LineIndex<T extends Span> {
  private readonly lines = new Map<number, T[]>();
  private readonly doc: Text;

  constructor(doc: Text, items: readonly T[]) {
    this.doc = doc;
    for (const item of items) {
      const last = doc.lineAt(item.to).number;
      for (let n = doc.lineAt(item.from).number; n <= last; n++) {
        const list = this.lines.get(n);
        if (list) list.push(item);
        else this.lines.set(n, [item]);
      }
    }
  }

  /** The items on the lines of `from`..`to`, each once. */
  around(from: number, to: number): T[] {
    const first = this.doc.lineAt(from).number;
    const last = this.doc.lineAt(to).number;
    if (first === last) return this.lines.get(first) ?? [];
    const seen = new Set<T>();
    for (let n = first; n <= last; n++) for (const item of this.lines.get(n) ?? []) seen.add(item);
    return [...seen];
  }
}

/** Whether every non-blank character of `span` is inside one of `elements` (its markup or its text). */
function covered(state: EditorState, span: Span, elements: readonly LiveElement[]): boolean {
  const merged = mergeSpans(elements.map((e) => ({ from: e.from, to: e.to })));
  for (const piece of subtract(span, merged)) {
    if (state.sliceDoc(piece.from, piece.to).trim() !== '') return false;
  }
  return true;
}

/** Whether all of `segments` have `format`. */
function allFormatted(state: EditorState, segments: readonly Span[], format: InlineFormat, index: LineIndex<LiveElement>): boolean {
  return segments.every((s) =>
    covered(
      state,
      s,
      index.around(s.from, s.to).filter((e) => e.kind === format),
    ),
  );
}

/** Formatting that new inline code takes off, as code shows its markers as text. */
const CODE_STRIPS: ReadonlySet<ElementKind> = new Set(['strong', 'emphasis', 'strikethrough', 'highlight']);

/**
 * The changes that apply `format` to `segments` (selected text), merging with the same format around
 * them: the markers that go, and the markers that come, both in the positions of `state`.
 */
function formatChanges(state: EditorState, segments: readonly Span[], format: InlineFormat, index: LineIndex<LiveElement>): { removals: Span[]; inserts: ChangeSpec[] } {
  // A range takes in the atomic elements it cuts into, and the same format it overlaps or touches.
  const extended = mergeSpans(
    segments.map((s) => {
      const x = { ...s };
      for (let changed = true; changed; ) {
        changed = false;
        for (const e of index.around(x.from, x.to)) {
          if (ATOMIC.has(e.kind) && e.kind !== format) {
            if (e.from < x.from && x.from < e.to) {
              x.from = e.from;
              changed = true;
            }
            if (e.from < x.to && x.to < e.to) {
              x.to = e.to;
              changed = true;
            }
          } else if (e.kind === format && e.to >= x.from && e.from <= x.to && (e.from < x.from || e.to > x.to)) {
            x.from = Math.min(x.from, e.from);
            x.to = Math.max(x.to, e.to);
            changed = true;
          }
        }
      }
      return x;
    }),
  );
  const removals: Span[] = [];
  const inserts: ChangeSpec[] = [];
  for (const x of extended) {
    const elements = index.around(x.from, x.to);
    // The same format inside goes (it merges into this one); so does other formatting inside new code.
    const removed: Span[] = [];
    for (const e of elements) {
      if (e.from < x.from || e.to > x.to) continue;
      if (e.kind === format || (format === 'code' && CODE_STRIPS.has(e.kind))) removed.push({ from: e.from, to: e.textFrom }, { from: e.textTo, to: e.to });
    }
    removals.push(...removed);
    // Formatting whose edge the range crosses splits it, so the Markdown stays nested.
    const gaps: Span[] = [];
    for (const e of elements) {
      if (!NESTING.has(e.kind) || e.kind === format) continue;
      if (e.from < x.from && x.from < e.to && e.to < x.to) gaps.push({ from: e.textTo, to: e.to });
      else if (x.from < e.from && e.from < x.to && x.to < e.to) gaps.push({ from: e.from, to: e.textFrom });
    }
    for (const piece of subtract(x, gaps)) {
      const p = trim(state, piece.from, piece.to);
      if (p.to <= p.from) continue;
      const text = subtract(p, removed)
        .map((r) => state.sliceDoc(r.from, r.to))
        .join('');
      if (text.trim() === '') continue;
      const { open, close } = markersFor(format, text);
      inserts.push({ from: p.from, insert: open }, { from: p.to, insert: close });
    }
  }
  return { removals: mergeSpans(removals).filter((r) => r.to > r.from), inserts };
}

/** The changes that take `format` off `segments`, splitting formatting that is selected only in part. */
function unformatChanges(state: EditorState, segments: readonly Span[], format: InlineFormat, index: LineIndex<LiveElement>): ChangeSpec[] {
  const selected = new LineIndex(state.doc, segments);
  const own = new Set<LiveElement>();
  for (const s of segments) for (const e of index.around(s.from, s.to)) if (e.kind === format) own.add(e);
  const changes: ChangeSpec[] = [];
  for (const e of own) {
    const hits = selected.around(e.from, e.to).filter((s) => s.to > e.from && s.from < e.to);
    if (hits.length === 0) continue;
    let a = Math.max(e.textFrom, Math.min(...hits.map((s) => s.from)));
    let b = Math.min(e.textTo, Math.max(...hits.map((s) => s.to)));
    const removeAll = () => changes.push({ from: e.from, to: e.textFrom }, { from: e.textTo, to: e.to });
    if (a >= b) {
      if (hits.some((s) => s.from <= e.from && s.to >= e.to)) removeAll();
      continue;
    }
    // Taking the format off part of a nested element takes it off all of it.
    const nested = index.around(e.from, e.to).filter((n) => n !== e && n.from >= e.textFrom && n.to <= e.textTo);
    for (let changed = true; changed; ) {
      changed = false;
      for (const n of nested) {
        if (n.from < a && a < n.to) {
          a = n.from;
          changed = true;
        }
        if (n.from < b && b < n.to) {
          b = n.to;
          changed = true;
        }
      }
    }
    const left = trim(state, e.textFrom, a);
    const right = trim(state, b, e.textTo);
    const keepLeft = left.to > left.from;
    const keepRight = right.to > right.from;
    // Markers that share a run with an enclosing element's (`***ab cd ef***`, bold in italic) would
    // pair up differently once split: the format comes off all of the element instead.
    const markerChar = state.sliceDoc(e.from, e.from + 1);
    const sharesRun = format !== 'code' && (state.sliceDoc(e.from - 1, e.from) === markerChar || state.sliceDoc(e.to, e.to + 1) === markerChar);
    if ((!keepLeft && !keepRight) || sharesRun) {
      removeAll();
      continue;
    }
    const open = state.sliceDoc(e.from, e.textFrom);
    const close = state.sliceDoc(e.textTo, e.to);
    if (format === 'code') {
      // Each piece of code gets the markers its own text needs (it may hold backticks).
      if (keepLeft) {
        const m = codeMarkers(state.sliceDoc(e.textFrom, left.to));
        changes.push({ from: e.from, to: e.textFrom, insert: m.open }, { from: left.to, insert: m.close });
      } else {
        changes.push({ from: e.from, to: e.textFrom });
      }
      if (keepRight) {
        const m = codeMarkers(state.sliceDoc(right.from, e.textTo));
        changes.push({ from: right.from, insert: m.open }, { from: e.textTo, to: e.to, insert: m.close });
      } else {
        changes.push({ from: e.textTo, to: e.to });
      }
      continue;
    }
    // Underscores cannot open or close inside a word, so a split writes the canonical markers.
    const marker = FORMAT_MARKERS[format];
    if (keepLeft) {
      if (open !== marker) changes.push({ from: e.from, to: e.textFrom, insert: marker });
      changes.push({ from: left.to, insert: marker });
    } else {
      changes.push({ from: e.from, to: e.textFrom });
    }
    if (keepRight) {
      changes.push({ from: right.from, insert: marker });
      if (close !== marker) changes.push({ from: e.textTo, to: e.to, insert: marker });
    } else {
      changes.push({ from: e.textTo, to: e.to });
    }
  }
  return changes;
}

/** Whether all of `range`'s text (or, at a cursor, the text there) has `format`. */
export function hasFormat(state: EditorState, range: SelectionRange, format: InlineFormat): boolean {
  if (range.empty) {
    const pending = state.field(pendingFormats, false);
    if (pending && pending.pos === range.head) return pending.formats.includes(format);
    return elementsAround(state, range.head, range.head).some((e) => e.kind === format && e.textFrom <= range.head && range.head <= e.textTo);
  }
  const tree = treeTo(state, state.doc.lineAt(range.to).to);
  if (!tree) return false;
  const segments = textSegments(state, range.from, range.to, tree);
  return segments.length > 0 && allFormatted(state, segments, format, new LineIndex(state.doc, elementsAround(state, range.from, range.to, tree)));
}

/** Whether `range` is inside a link (a Markdown link, wikilink or web address). */
export function inLink(state: EditorState, range: SelectionRange): boolean {
  return elementsAround(state, range.from, range.to).some((e) => LINKS.has(e.kind) && e.from <= range.from && range.to <= e.to && (!range.empty || (e.from < range.head && range.head < e.to)));
}

// ---------- pending formats (a format switched on at the cursor) ----------

interface Pending {
  pos: number;
  formats: readonly InlineFormat[];
}

const setPending = StateEffect.define<Pending | null>();

/**
 * Formats switched on at the cursor with nothing selected and no word around it: nothing is written
 * until you type, and then the typed text comes with its markers (`**x**`, the cursor inside them).
 * So an unused toggle leaves nothing behind (an empty `~~~~` would open a code block, `====` would
 * turn the line above into a heading). Moving the cursor or editing elsewhere forgets them.
 */
export const pendingFormats = StateField.define<Pending | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (!value) return null;
    if (tr.docChanged) {
      if (!tr.annotation(Transaction.remote)) return null;
      value = { ...value, pos: tr.changes.mapPos(value.pos) };
    }
    const { selection } = tr.state;
    return selection.ranges.length === 1 && selection.main.empty && selection.main.head === value.pos ? value : null;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (p) => (p ? Decoration.set([Decoration.widget({ widget: new PendingWidget(p.formats), side: 1 }).range(p.pos)]) : Decoration.none)),
});

const PENDING_LABELS: Record<InlineFormat, string> = { strong: 'B', emphasis: 'I', strikethrough: 'S', highlight: 'H', code: '</>' };

/** A small, faint mark after the cursor showing the formats the next typed text gets. */
class PendingWidget extends WidgetType {
  readonly formats: readonly InlineFormat[];
  constructor(formats: readonly InlineFormat[]) {
    super();
    this.formats = formats;
  }
  override eq(other: PendingWidget): boolean {
    return other.formats.join() === this.formats.join();
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pending-format';
    el.setAttribute('aria-hidden', 'true');
    for (const f of this.formats) {
      const label = document.createElement('span');
      label.className = `cm-pending-${f}`;
      label.textContent = PENDING_LABELS[f];
      el.appendChild(label);
    }
    return el;
  }
}

/** Typed text at the cursor takes the pending formats; blanks typed first move them along. */
const typeWithPending = EditorView.inputHandler.of((view, from, to, text) => {
  const pending = view.state.field(pendingFormats, false);
  if (!pending || from !== pending.pos || to !== from || view.composing || view.state.readOnly || text.includes('\n')) return false;
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  if (lead.length === text.length) {
    view.dispatch({ changes: { from, insert: text }, selection: EditorSelection.cursor(from + text.length), effects: setPending.of({ ...pending, pos: from + text.length }), userEvent: 'input.type' });
    return true;
  }
  const typed = text.slice(lead.length).trimEnd();
  const trail = text.slice(lead.length + typed.length);
  // A marker character at an edge of the typed text would merge with the markers (`=` with
  // highlight pending would write `=====`, a heading underline): it is escaped. Inside code it is literal.
  let body = typed;
  if (!pending.formats.includes('code')) {
    if (/^[*_~=]/.test(body)) body = '\\' + body;
    if (body.length > 1 && /[*_~=]$/.test(body) && !/\\[*_~=]$/.test(body)) body = body.slice(0, -1) + '\\' + body.slice(-1);
  }
  let open = '';
  let close = '';
  for (const f of pending.formats) {
    const m = markersFor(f, body);
    open += m.open;
    close = m.close + close;
  }
  view.dispatch({
    changes: { from, insert: lead + open + body + close + trail },
    selection: EditorSelection.cursor(from + lead.length + open.length + body.length + (trail ? close.length + trail.length : 0)),
    userEvent: 'input.type',
  });
  return true;
});

// ---------- the commands ----------

/** The word the cursor is inside (not at its edge), if any. */
function wordAround(state: EditorState, pos: number): Span | null {
  const word = state.wordAt(pos);
  return word && word.from < pos && pos < word.to ? { from: word.from, to: word.to } : null;
}

/** The innermost (shortest) of the elements that pass `test`. */
function innermost(elements: readonly LiveElement[], test: (e: LiveElement) => boolean): LiveElement | null {
  let best: LiveElement | null = null;
  for (const e of elements) {
    if (!test(e)) continue;
    if (!best || e.to - e.from < best.to - best.from) best = e;
  }
  return best;
}

/** What a format toggle does at a cursor (DESIGN §6.6.1). */
function toggleAtCursor(state: EditorState, range: SelectionRange, format: InlineFormat, single: boolean): { changes?: ChangeSpec[]; range: SelectionRange; pending?: Pending | null } {
  const pos = range.head;
  const elements = elementsAround(state, pos, pos);
  const own = innermost(elements, (e) => e.kind === format && e.textFrom <= pos && pos <= e.textTo && e.textTo > e.textFrom);
  if (own) {
    // At the end of formatted text the cursor steps out of it (typing goes on unformatted), at its start in front of it.
    if (pos === own.textTo) return { range: EditorSelection.cursor(own.to, -1) };
    if (pos === own.textFrom) return { range: EditorSelection.cursor(own.from, 1) };
    const changes = [
      { from: own.from, to: own.textFrom },
      { from: own.textTo, to: own.to },
    ];
    return { changes, range: EditorSelection.cursor(pos - (own.textFrom - own.from)) };
  }
  const atomic = innermost(elements, (e) => ATOMIC.has(e.kind) && e.kind !== format && e.from < pos && pos < e.to);
  const word = atomic ? { from: atomic.from, to: atomic.to } : wordAround(state, pos);
  if (word) {
    // As on a selection: the word merges with the same format it touches (`**bold**word`).
    const { removals, inserts } = formatChanges(state, [word], format, new LineIndex(state.doc, elements));
    const removed = state.changes(removals);
    const changes = removed.compose(state.changes(inserts).map(removed));
    return { changes: [changes], range: EditorSelection.cursor(changes.mapPos(pos, 1)) };
  }
  const pending = state.field(pendingFormats, false);
  if (single && pending !== undefined) {
    const current = pending && pending.pos === pos ? pending.formats : [];
    const formats = current.includes(format) ? current.filter((f) => f !== format) : [...current, format];
    return { range, pending: formats.length ? { pos, formats } : null };
  }
  // Without the pending-format state (a plain editor), the empty markers are written.
  const { open, close } = markersFor(format, '');
  return { changes: [{ from: pos, insert: open + close }], range: EditorSelection.cursor(pos + open.length) };
}

/**
 * Toggles an inline format (DESIGN §6.6.1). On a selection: if all of its text has the format, it
 * comes off (splitting formatting selected in part), otherwise all of it gets the format, merged
 * with the same format around it, line by line. At the cursor: at the end of formatted text the
 * cursor steps out of it, inside it the format comes off, inside a word the word gets it, and
 * elsewhere the format applies to what you type next.
 */
export function toggleFormat(format: InlineFormat): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const ranges = state.selection.ranges.filter((r) => !r.empty);
    if (ranges.length === 0) {
      const single = state.selection.ranges.length === 1;
      let pending: Pending | null | undefined;
      const tr = state.changeByRange((range) => {
        const result = toggleAtCursor(state, range, format, single);
        if (result.pending !== undefined) pending = result.pending;
        return { changes: result.changes ?? [], range: result.range };
      });
      view.dispatch(state.update(tr, { userEvent: 'input.format', scrollIntoView: true, effects: pending !== undefined ? setPending.of(pending) : [] }));
      return true;
    }
    const tree = treeTo(state, state.doc.lineAt(ranges.reduce((m, r) => Math.max(m, r.to), 0)).to);
    if (!tree) {
      toast('This note is still being read; try again in a moment');
      return true;
    }
    const segments = ranges.flatMap((r) => textSegments(state, r.from, r.to, tree));
    if (segments.length === 0) return true;
    const from = segments.reduce((m, s) => Math.min(m, s.from), state.doc.length);
    const to = segments.reduce((m, s) => Math.max(m, s.to), 0);
    const index = new LineIndex(state.doc, elementsAround(state, from, to, tree));
    const off = allFormatted(state, segments, format, index);
    const { removals, inserts } = off ? { removals: [], inserts: unformatChanges(state, segments, format, index) } : formatChanges(state, segments, format, index);
    // Markers merged away go first, then the new ones: a selection starting where an old opening
    // marker was then starts after the new one.
    const removed = state.changes(removals);
    const added = state.changes(inserts).map(removed);
    const changes = removed.compose(added);
    const map = (pos: number, assoc: -1 | 1) => added.mapPos(removed.mapPos(pos, assoc), assoc);
    // The selected text stays selected, inside the markers.
    const selection = EditorSelection.create(
      state.selection.ranges.map((r) => {
        if (r.empty) return EditorSelection.cursor(changes.mapPos(r.head));
        const from = map(r.from, 1);
        const to = Math.max(from, map(r.to, -1));
        return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }),
      state.selection.mainIndex,
    );
    view.dispatch({ changes, selection, userEvent: 'input.format', scrollIntoView: true });
    return true;
  };
}

export const toggleBold: Command = toggleFormat('strong');
export const toggleItalic: Command = toggleFormat('emphasis');
export const toggleStrikethrough: Command = toggleFormat('strikethrough');
export const toggleHighlight: Command = toggleFormat('highlight');
export const toggleInlineCode: Command = toggleFormat('code');

/** The text a link shows, for taking the link off. */
function linkText(state: EditorState, e: LiveElement): string {
  if (e.kind === 'wikilink') {
    const { target, subpath, display } = splitWikiBody(state.sliceDoc(e.from + 2, e.to - 2));
    if (display) return display;
    // `[[Note#Heading]]` shows "Note > Heading", as the reading view does (`[[Note|]]` shows "Note").
    const parts = [target, ...(subpath ? subpath.split('#') : [])].filter((p) => p !== '');
    return parts.join(' > ');
  }
  return state.sliceDoc(e.textFrom, e.textTo);
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)\S+$/i;

/** A web address as a link's destination: `www.example.com` gets its `https://` (without it, it reads as a note). */
function webDestination(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

/**
 * Mod-K (DESIGN §6.6.1): in a link, takes the link off and keeps its text. A selected web address
 * becomes `[](address)` with the cursor on the text to type; other selected text, or the word at
 * the cursor, becomes `[text]()` with the cursor where the address goes; elsewhere `[]()`.
 */
export const toggleLink: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    const elements = elementsAround(state, range.from, range.to);
    const inLink = (e: LiveElement) => LINKS.has(e.kind) && e.from <= range.from && range.to <= e.to && (!range.empty || (e.from < range.head && range.head < e.to) || (e.kind === 'url' && range.head === e.to));
    const link = innermost(elements, inLink);
    if (link?.kind === 'url') {
      const url = webDestination(state.sliceDoc(link.from, link.to));
      return { changes: { from: link.from, to: link.to, insert: `[](${url})` }, range: EditorSelection.cursor(link.from + 1) };
    }
    if (link) {
      const text = linkText(state, link);
      const offset = link.kind !== 'wikilink' && range.head >= link.textFrom && range.head <= link.textTo ? range.head - link.textFrom : text.length;
      return { changes: { from: link.from, to: link.to, insert: text }, range: EditorSelection.cursor(link.from + offset) };
    }
    const span = range.empty ? wordAround(state, range.head) : { from: range.from, to: range.to };
    if (!span) return { changes: { from: range.head, insert: '[]()' }, range: EditorSelection.cursor(range.head + 1) };
    const text = state.sliceDoc(span.from, span.to);
    if (URL_LIKE.test(text)) return { changes: { from: span.from, to: span.to, insert: `[](${webDestination(text)})` }, range: EditorSelection.cursor(span.from + 1) };
    return { changes: { from: span.from, to: span.to, insert: `[${text}]()` }, range: EditorSelection.cursor(span.from + text.length + 3) };
  });
  view.dispatch(state.update(tr, { userEvent: 'input.format', scrollIntoView: true }));
  return true;
};

// ---------- line formats ----------

/** A line's block markup: indentation and quotes (kept), a list marker with its task box, heading marks. */
const LINE_MARKUP = /^([ \t]*(?:>[ \t]?)*[ \t]*)((?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(#{1,6}(?:[ \t]+|$))?/;

interface LineMarkup {
  from: number;
  /** Where the line's text starts. */
  textFrom: number;
  keep: string;
  list: string;
  heading: string;
  blank: boolean;
}

/** The syntax tree over the selection's lines, or null (with a toast) when the parse takes too long. */
function selectionTree(state: EditorState): Tree | null {
  const tree = treeTo(state, state.doc.lineAt(state.selection.ranges.reduce((m, r) => Math.max(m, r.to), 0)).to);
  if (!tree) toast('This note is still being read; try again in a moment');
  return tree;
}

/**
 * The lines a line command changes: those of the selection (blank ones only when nothing else is
 * selected), outside code and tables. Null when the note is not parsed that far yet.
 */
/** The last line a range covers: a selection that ends at the start of a line (a triple click) leaves that line out. */
function lastLine(state: EditorState, r: SelectionRange): number {
  const line = state.doc.lineAt(r.to);
  return !r.empty && r.to === line.from && line.number > 1 ? line.number - 1 : line.number;
}

function targetLines(state: EditorState, tree: Tree | null = selectionTree(state)): LineMarkup[] | null {
  if (!tree) return null;
  const lines = new Map<number, LineMarkup>();
  for (const r of state.selection.ranges) {
    const last = lastLine(state, r);
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      if (lines.has(line.from) || (line.length > 0 && blockAt(state, line.from, tree) !== null)) continue;
      const m = LINE_MARKUP.exec(line.text)!;
      lines.set(line.from, { from: line.from, textFrom: line.from + m[0].length, keep: m[1], list: m[2] ?? '', heading: m[3] ?? '', blank: line.text.trim() === '' });
    }
  }
  const all = [...lines.values()];
  const filled = all.filter((l) => !l.blank);
  return filled.length > 0 ? filled : all;
}

/** Rewrites each target line's list and heading markup, keeping the cursor after it. */
function rewriteLines(view: EditorView, markup: (line: LineMarkup, index: number) => { list: string; heading: string } | null): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const lines = targetLines(state);
  if (!lines) return true;
  const changes: ChangeSpec[] = [];
  lines.forEach((line, i) => {
    const next = markup(line, i);
    if (!next || (next.list === line.list && next.heading === line.heading)) return;
    changes.push({ from: line.from + line.keep.length, to: line.textFrom, insert: next.list + next.heading });
  });
  if (changes.length === 0) return true;
  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: state.selection.map(set, 1), userEvent: 'input.format', scrollIntoView: true });
  return true;
}

function headingLevel(line: LineMarkup): number {
  return line.heading ? line.heading.trimEnd().length : 0;
}

/** Makes the lines headings of `level` (0: plain text). A heading replaces a list marker. */
export function setHeading(view: EditorView, level: number): boolean {
  return rewriteLines(view, (line) => (level === 0 ? { list: line.list, heading: '' } : { list: '', heading: '#'.repeat(level) + ' ' }));
}

/** Toggles headings of `level`: lines that all are one become plain text. */
export function toggleHeading(level: number): Command {
  return (view) => {
    const lines = targetLines(view.state);
    if (!lines) return true;
    return setHeading(view, lines.length > 0 && lines.every((l) => headingLevel(l) === level) ? 0 : level);
  };
}

/** The phone toolbar's heading button: plain text, heading 1, 2, 3, then plain text again. */
export const cycleHeading: Command = (view) => {
  const lines = targetLines(view.state);
  if (!lines) return true;
  const first = lines[0];
  const level = first ? headingLevel(first) : 0;
  return setHeading(view, level === 0 ? 1 : level >= 3 ? 0 : level + 1);
};

const BULLET = /^[-+*][ \t]+$/;
const ORDERED = /^(\d{1,9})[.)][ \t]+$/;

/** Toggles a bulleted list: lines that all are bullets become plain text; otherwise each becomes `- `. */
export const toggleBulletList: Command = (view) => {
  const lines = targetLines(view.state);
  if (!lines) return true;
  const all = lines.length > 0 && lines.every((l) => BULLET.test(l.list));
  return rewriteLines(view, (line) => ({ list: all ? '' : BULLET.test(line.list) ? line.list : '- ', heading: '' }));
};

/** Toggles a numbered list: lines that all are numbered become plain text; otherwise they are numbered, continuing a list above. */
export const toggleNumberedList: Command = (view) => {
  const { state } = view;
  const lines = targetLines(state);
  if (!lines) return true;
  const all = lines.length > 0 && lines.every((l) => ORDERED.test(l.list));
  let start = 1;
  const first = lines[0];
  if (first && !all) {
    const above = state.doc.lineAt(first.from).number > 1 ? state.doc.lineAt(first.from - 1) : null;
    const m = above ? LINE_MARKUP.exec(above.text) : null;
    const n = m?.[2] ? ORDERED.exec(m[2]) : null;
    if (n && m?.[1] === first.keep) start = Number(n[1]) + 1;
  }
  return rewriteLines(view, (_line, i) => ({ list: all ? '' : `${start + i}. `, heading: '' }));
};

/** Toggles a quote: lines that all are quoted lose one level, otherwise each gets `> `. */
export const toggleQuote: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const tree = selectionTree(state);
  if (!tree) return true;
  const lines = new Map<number, string>();
  for (const r of state.selection.ranges) {
    const last = lastLine(state, r);
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      // Any block can be quoted, except the frontmatter (blank lines in it included).
      if (blockAt(state, line.from, tree) !== 'Frontmatter') lines.set(line.from, line.text);
    }
  }
  if (lines.size === 0) return true;
  // Quoted or not is the text lines' say; blank lines alone (an empty line) get quoted.
  const texts = [...lines.values()].filter((t) => t.trim() !== '');
  const quoted = texts.length > 0 && texts.every((t) => /^[ \t]*>/.test(t));
  const changes: ChangeSpec[] = [];
  for (const [from, text] of lines) {
    if (quoted) {
      const m = /^([ \t]*)>[ \t]?/.exec(text);
      if (m) changes.push({ from: from + m[1].length, to: from + m[0].length });
    } else {
      changes.push({ from, insert: text.trim() === '' && texts.length > 0 ? '>' : '> ' });
    }
  }
  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: state.selection.map(set, 1), userEvent: 'input.format', scrollIntoView: true });
  return true;
};

/** The state of the formatting commands: pending formats, and typed text taking them. */
export function formatting(): Extension {
  return [pendingFormats, Prec.highest(typeWithPending)];
}
