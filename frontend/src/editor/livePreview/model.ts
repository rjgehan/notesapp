// Live Preview model (DESIGN §6.6.1): the Markdown markup that Live Preview hides, shows as a
// widget or styles, read from the Lezer tree v1 already parses, for a set of document ranges (the
// editor's visible ranges, or one line). Pure and DOM-free: the decorations, the atomic ranges and
// the cursor rules all derive from it, and decorations never change the document.
import { syntaxTree } from '@codemirror/language';
import type { EditorSelection, EditorState, Line } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * How the cursor treats a replaced range (DESIGN §6.6.1):
 * - `prefix`: block markup at the start of a line (heading `#`, quote `>`, a bullet, a task box). The
 *   cursor never stops in front of it, so typing never breaks the markup.
 * - `open`: the opening marker of inline formatting or a link. A click at its edge puts the cursor in
 *   front of it, so the text typed there stays outside.
 * - `close`: the closing marker of formatting that typing continues (bold, italic, strikethrough,
 *   highlight, a heading's closing `#`s). A click at its edge puts the cursor inside it.
 * - `close-link`: the closing marker of a link or inline code. A click at its edge puts the cursor
 *   after it, so typing does not extend the link.
 * - `inner`: markup inside an element's text (the `#` of `[[Note#Heading]]`, shown as " > ").
 * - `block`: a whole line shown as a widget (`---`).
 */
export type PieceRole = 'prefix' | 'open' | 'close' | 'close-link' | 'inner' | 'block';

export type WidgetSpec =
  | { type: 'bullet'; depth: number }
  | { type: 'checkbox'; checked: boolean; depth: number }
  | { type: 'rule' }
  | { type: 'text'; text: string; className: string };

export type ElementKind = 'heading' | 'quote' | 'list' | 'rule' | 'emphasis' | 'strong' | 'strikethrough' | 'highlight' | 'code' | 'link' | 'wikilink' | 'autolink' | 'url';

/** A replaced range of markup: hidden, or shown as a widget. */
export interface Piece {
  from: number;
  to: number;
  role: PieceRole;
  widget: WidgetSpec | null;
  /** The kind of element the markup belongs to. */
  kind: ElementKind;
}

type PieceDraft = Omit<Piece, 'kind'>;

/** Elements whose visible text formatting continues into: deleting all of it removes the element. */
export const INLINE_KINDS: ReadonlySet<ElementKind> = new Set(['emphasis', 'strong', 'strikethrough', 'highlight', 'code', 'link', 'wikilink', 'autolink']);

export interface LiveElement {
  kind: ElementKind;
  from: number;
  to: number;
  /** The visible text (empty for block markup). */
  textFrom: number;
  textTo: number;
  /** A selection touching this range shows the element's markup in reveal-at-cursor mode. */
  revealFrom: number;
  revealTo: number;
  pieces: Piece[];
  /** Classes on the visible text, kept while the markup shows. */
  marks: Array<{ from: number; to: number; className: string }>;
  /** A class of the element's line, kept while the markup shows. */
  lineClass?: { at: number; className: string };
  /** A list line's hanging indent in em, while its markup is hidden. */
  hangingIndent?: { at: number; em: number };
}

/** An element as a node handler builds it; its pieces get the element's kind. */
interface Draft extends Omit<LiveElement, 'pieces'> {
  pieces: PieceDraft[];
}

/** Width of one list level, and of a bullet or task box, in em (the reading view's list indent). */
export const LIST_INDENT_EM = 1.6;

/** Subtrees Live Preview leaves as typed: code, HTML, comments, frontmatter, and what 10a/10b render as blocks. */
const SKIP = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Comment', 'Frontmatter', 'Embed', 'Image', 'Table', 'LinkReference']);

const HEADING = /^ATXHeading([1-6])$/;

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

/** The first position at or after `pos` (up to `limit`) that is not a space or tab. */
function skipBlanks(state: EditorState, pos: number, limit: number): number {
  const text = state.sliceDoc(pos, limit);
  let i = 0;
  while (i < text.length && isBlank(text[i])) i++;
  return pos + i;
}

/** The position after the last character before `pos` (down to `limit`) that is not a space or tab. */
function trimBlanksBack(state: EditorState, limit: number, pos: number): number {
  const text = state.sliceDoc(limit, pos);
  let i = text.length;
  while (i > 0 && isBlank(text[i - 1])) i--;
  return limit + i;
}

function heading(state: EditorState, node: SyntaxNode): Draft | null {
  const marks = node.getChildren('HeaderMark');
  const open = marks[0];
  if (!open) return null;
  // `#` alone is not a heading being written yet (a line-start `#tag` is typed through it).
  if (!isBlank(state.sliceDoc(open.to, open.to + 1))) return null;
  const line = state.doc.lineAt(open.from);
  const close = marks.length > 1 ? marks[marks.length - 1] : null;
  const textFrom = skipBlanks(state, open.to, close ? close.from : node.to);
  const pieces: PieceDraft[] = [{ from: open.from, to: textFrom, role: 'prefix', widget: null }];
  let textTo = node.to;
  if (close) {
    textTo = Math.max(textFrom, trimBlanksBack(state, textFrom, close.from));
    pieces.push({ from: textTo, to: close.to, role: 'close', widget: null });
  }
  return { kind: 'heading', from: node.from, to: node.to, textFrom, textTo, revealFrom: line.from, revealTo: line.to, pieces, marks: [] };
}

function quote(state: EditorState, mark: SyntaxNode): Draft {
  const line = state.doc.lineAt(mark.from);
  const to = isBlank(state.sliceDoc(mark.to, mark.to + 1)) ? mark.to + 1 : mark.to;
  return { kind: 'quote', from: mark.from, to, textFrom: to, textTo: to, revealFrom: line.from, revealTo: line.to, pieces: [{ from: mark.from, to, role: 'prefix', widget: null }], marks: [] };
}

function listDepth(item: SyntaxNode): number {
  let depth = -1;
  for (let n: SyntaxNode | null = item.parent; n; n = n.parent) if (n.name === 'BulletList' || n.name === 'OrderedList') depth++;
  return Math.max(0, depth);
}

/** Where a list item's indentation starts: after any quote markup at the start of its line. */
function indentStart(line: Line, markFrom: number): number {
  const before = line.text.slice(0, markFrom - line.from);
  const quoted = /^(?:[ \t]*>[ \t]?)*/.exec(before)?.[0].length ?? 0;
  return /^[ \t]*$/.test(before.slice(quoted)) ? line.from + quoted : markFrom;
}

function listItem(state: EditorState, node: SyntaxNode): Draft | null {
  const mark = node.getChild('ListMark');
  // `-` or `1.` without a space after it is not a list item being written yet.
  if (!mark || !isBlank(state.sliceDoc(mark.to, mark.to + 1))) return null;
  const line = state.doc.lineAt(mark.from);
  const ordered = node.parent?.name === 'OrderedList';
  const depth = listDepth(node);
  const indentFrom = indentStart(line, mark.from);
  const afterMark = skipBlanks(state, mark.to, line.to);
  const box = node.getChild('Task')?.getChild('TaskMarker');
  const number = ordered ? [{ from: mark.from, to: mark.to, className: 'cm-lp-list-number' }] : [];
  const base = { kind: 'list' as const, from: node.from, to: node.to };
  if (box && box.from === afterMark) {
    const textFrom = skipBlanks(state, box.to, line.to);
    const checked = state.sliceDoc(box.from + 1, box.from + 2) !== ' ';
    const lineClass = { at: line.from, className: checked ? 'cm-lp-task cm-lp-task-done' : 'cm-lp-task' };
    // An unordered task shows just its box, as Obsidian does; a numbered one keeps its number.
    const from = ordered ? box.from : indentFrom;
    return {
      ...base,
      textFrom,
      textTo: textFrom,
      revealFrom: from,
      revealTo: textFrom,
      pieces: [{ from, to: textFrom, role: 'prefix', widget: { type: 'checkbox', checked, depth: ordered ? 0 : depth } }],
      marks: number,
      lineClass,
      hangingIndent: ordered ? undefined : { at: line.from, em: (depth + 1) * LIST_INDENT_EM },
    };
  }
  if (ordered) return { ...base, textFrom: afterMark, textTo: afterMark, revealFrom: mark.from, revealTo: afterMark, pieces: [], marks: number };
  return {
    ...base,
    textFrom: afterMark,
    textTo: afterMark,
    revealFrom: indentFrom,
    revealTo: afterMark,
    pieces: [{ from: indentFrom, to: afterMark, role: 'prefix', widget: { type: 'bullet', depth } }],
    marks: [],
    hangingIndent: { at: line.from, em: (depth + 1) * LIST_INDENT_EM },
  };
}

function rule(state: EditorState, node: SyntaxNode): Draft {
  const line = state.doc.lineAt(node.from);
  return { kind: 'rule', from: node.from, to: node.to, textFrom: node.to, textTo: node.to, revealFrom: line.from, revealTo: line.to, pieces: [{ from: node.from, to: node.to, role: 'block', widget: { type: 'rule' } }], marks: [] };
}

/** Inline formatting between an opening and a closing marker (`**bold**`, `==mark==`, `` `code` ``). */
function delimited(node: SyntaxNode, kind: ElementKind, markName: string, closeRole: PieceRole): Draft | null {
  const marks = node.getChildren(markName);
  if (marks.length < 2) return null;
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (open.from !== node.from || close.to !== node.to || open.to >= close.from) return null;
  return {
    kind,
    from: node.from,
    to: node.to,
    textFrom: open.to,
    textTo: close.from,
    revealFrom: node.from,
    revealTo: node.to,
    pieces: [
      { from: open.from, to: open.to, role: 'open', widget: null },
      { from: close.from, to: close.to, role: closeRole, widget: null },
    ],
    marks: [],
  };
}

/** `[text](url "title")`: the text, as a link. Reference links and links without text show as typed. */
function link(node: SyntaxNode): Draft | null {
  const marks = node.getChildren('LinkMark');
  if (!node.getChild('URL') || marks.length < 4) return null;
  const [open, close] = marks;
  if (open.from !== node.from || close.from <= open.to) return null;
  return {
    kind: 'link',
    from: node.from,
    to: node.to,
    textFrom: open.to,
    textTo: close.from,
    revealFrom: node.from,
    revealTo: node.to,
    pieces: [
      { from: node.from, to: open.to, role: 'open', widget: null },
      { from: close.from, to: node.to, role: 'close-link', widget: null },
    ],
    marks: [{ from: open.to, to: close.from, className: 'cm-lp-link' }],
  };
}

function autolink(node: SyntaxNode): Draft | null {
  const url = node.getChild('URL');
  if (!url || url.from !== node.from + 1 || url.to !== node.to - 1) return null;
  return {
    kind: 'autolink',
    from: node.from,
    to: node.to,
    textFrom: url.from,
    textTo: url.to,
    revealFrom: node.from,
    revealTo: node.to,
    pieces: [
      { from: node.from, to: url.from, role: 'open', widget: null },
      { from: url.to, to: node.to, role: 'close-link', widget: null },
    ],
    marks: [{ from: url.from, to: url.to, className: 'cm-lp-link cm-lp-url' }],
  };
}

/**
 * `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]` (shown "Note > Heading", as in the reading view)
 * and `[[#Heading]]`. A link without a target shows as typed.
 */
function wikilink(state: EditorState, node: SyntaxNode): Draft | null {
  const target = node.getChild('WikiLinkTarget');
  const alias = node.getChild('WikiLinkAlias');
  if (!target) return null;
  const element = (textFrom: number, textTo: number, pieces: PieceDraft[]): Draft => ({
    kind: 'wikilink',
    from: node.from,
    to: node.to,
    textFrom,
    textTo,
    revealFrom: node.from,
    revealTo: node.to,
    pieces,
    marks: [{ from: textFrom, to: textTo, className: 'cm-lp-link' }],
  });
  if (alias) {
    return element(alias.from, alias.to, [
      { from: node.from, to: alias.from, role: 'open', widget: null },
      { from: alias.to, to: node.to, role: 'close-link', widget: null },
    ]);
  }
  const text = state.sliceDoc(target.from, target.to);
  let textFrom = target.from;
  const inner: PieceDraft[] = [];
  for (let i = text.indexOf('#'); i >= 0; i = text.indexOf('#', i + 1)) {
    const at = target.from + i;
    // `[[#Heading]]`: the leading `#` hides with the brackets.
    if (at === textFrom) textFrom = at + 1;
    else inner.push({ from: at, to: at + 1, role: 'inner', widget: { type: 'text', text: ' > ', className: 'cm-lp-link cm-lp-subpath' } });
  }
  if (textFrom >= target.to) return null;
  // An empty alias (`[[Note|]]`) hides its separator with the closing brackets.
  return element(textFrom, target.to, [
    { from: node.from, to: textFrom, role: 'open', widget: null },
    ...inner,
    { from: target.to, to: node.to, role: 'close-link', widget: null },
  ]);
}

function draftFor(state: EditorState, node: SyntaxNode): Draft | null {
  const name = node.name;
  if (HEADING.test(name)) return heading(state, node);
  switch (name) {
    case 'QuoteMark':
      return quote(state, node);
    case 'ListItem':
      return listItem(state, node);
    case 'HorizontalRule':
      return rule(state, node);
    case 'Emphasis':
      return delimited(node, 'emphasis', 'EmphasisMark', 'close');
    case 'StrongEmphasis':
      return delimited(node, 'strong', 'EmphasisMark', 'close');
    case 'Strikethrough':
      return delimited(node, 'strikethrough', 'StrikethroughMark', 'close');
    case 'Highlight':
      return delimited(node, 'highlight', 'HighlightMark', 'close');
    case 'InlineCode':
      return delimited(node, 'code', 'CodeMark', 'close-link');
    case 'Link':
      return link(node);
    case 'Autolink':
      return autolink(node);
    case 'WikiLink':
      return wikilink(state, node);
    case 'URL': {
      // A bare web address (GFM autolink): styled and clickable, nothing hidden.
      const parent = node.parent?.name;
      if (parent === 'Link' || parent === 'Autolink' || parent === 'Image') return null;
      return { kind: 'url', from: node.from, to: node.to, textFrom: node.from, textTo: node.to, revealFrom: node.from, revealTo: node.to, pieces: [], marks: [{ from: node.from, to: node.to, className: 'cm-lp-link cm-lp-url' }] };
    }
    default:
      return null;
  }
}

/**
 * The Live Preview elements of the syntax tree that overlap `ranges`, each once, in document order.
 * `tree` defaults to the state's (which may not reach past the viewport yet).
 */
export function collectElements(state: EditorState, ranges: readonly { from: number; to: number }[], tree: Tree = syntaxTree(state)): LiveElement[] {
  const seen = new Set<string>();
  const out: LiveElement[] = [];
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(ref) {
        const add = (node: SyntaxNode) => {
          const key = `${node.name}@${node.from}`;
          if (seen.has(key)) return;
          seen.add(key);
          const draft = draftFor(state, node);
          if (draft) out.push({ ...draft, pieces: draft.pieces.map((p) => ({ ...p, kind: draft.kind })) });
        };
        if (SKIP.has(ref.name)) {
          // The `>` of the lines a skipped block spans (a quoted table or code block) still hides.
          for (let child = ref.node.firstChild; child; child = child.nextSibling) if (child.name === 'QuoteMark') add(child);
          return false;
        }
        add(ref.node);
        return undefined;
      },
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

export interface RevealOptions {
  /** reveal-at-cursor: a selection touching an element shows its markup. */
  atCursor: boolean;
  /** A selection end inside hidden markup (a search match, a command's caret) shows that element. */
  atSelectionEnds: boolean;
  /** While autocompletion is open, the inline element at the cursor shows (the `[[` being typed). */
  completing: boolean;
}

/** Whether the markup of `element` shows instead of being replaced. */
export function isRevealed(element: LiveElement, selection: EditorSelection, options: RevealOptions): boolean {
  for (const r of selection.ranges) {
    if (options.atCursor && r.from <= element.revealTo && r.to >= element.revealFrom) return true;
    if (options.atSelectionEnds) {
      for (const p of element.pieces) {
        if ((r.anchor > p.from && r.anchor < p.to) || (r.head > p.from && r.head < p.to)) return true;
      }
    }
  }
  if (options.completing && INLINE_KINDS.has(element.kind)) {
    const head = selection.main.head;
    if (head >= element.from && head <= element.to) return true;
  }
  return false;
}

/** A run of adjacent replaced ranges the cursor treats as one. */
export interface Run {
  from: number;
  to: number;
  pieces: Piece[];
}

/**
 * Where the cursor may be around the replaced ranges:
 * - `zones`: the block prefix of a line (chained prefix pieces, from the line start when only
 *   blanks come before them). `to` is where the line's text starts.
 * - `runs`: adjacent inline pieces.
 * - `blocks`: lines shown as a widget.
 * Together they are the editor's atomic ranges.
 */
export interface Layout {
  zones: Run[];
  runs: Run[];
  blocks: Piece[];
}

export function layoutOf(state: EditorState, pieces: readonly Piece[]): Layout {
  const sorted = [...pieces].filter((p) => p.to > p.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const zones: Run[] = [];
  const runs: Run[] = [];
  const blocks: Piece[] = [];
  for (const p of sorted) {
    if (p.role === 'block') {
      blocks.push(p);
    } else if (p.role === 'prefix') {
      const last = zones.at(-1);
      if (last && last.to === p.from) {
        last.to = p.to;
        last.pieces.push(p);
      } else {
        const line = state.doc.lineAt(p.from);
        const from = /^[ \t]*$/.test(state.sliceDoc(line.from, p.from)) ? line.from : p.from;
        zones.push({ from, to: p.to, pieces: [p] });
      }
    } else {
      const last = runs.at(-1);
      if (last && last.to >= p.from) {
        last.to = Math.max(last.to, p.to);
        last.pieces.push(p);
      } else {
        runs.push({ from: p.from, to: p.to, pieces: [p] });
      }
    }
  }
  return { zones, runs, blocks };
}

/** The pieces of `elements` that are replaced (not revealed) for `selection`. */
export function hiddenPieces(elements: readonly LiveElement[], selection: EditorSelection, options: RevealOptions): Piece[] {
  const out: Piece[] = [];
  for (const el of elements) if (!isRevealed(el, selection, options)) out.push(...el.pieces);
  return out;
}

/** The layout of the markup that hide-all mode hides on the line at `pos` (DESIGN §6.6.1 cursor rules). */
export function lineLayout(state: EditorState, pos: number, selection: EditorSelection = state.selection, options: RevealOptions = HIDE_ALL): Layout {
  const line = state.doc.lineAt(pos);
  return layoutOf(state, hiddenPieces(collectElements(state, [{ from: line.from, to: line.to }]), selection, options));
}

/** Hide-all, ignoring the selection: every piece of markup is hidden. */
export const HIDE_ALL: RevealOptions = { atCursor: false, atSelectionEnds: false, completing: false };
