// Live Preview footnotes (DESIGN §6.6.1, ROADMAP 10b): `[^label]` references and `^[inline]`
// footnotes show as a superscript number, and hovering one (or tapping it) shows its text. The
// numbers are those the markdown-it footnote plugin gives: the order of each footnote's first
// reference, counting only labels that have a definition (a reference without one stays text in
// the reading of the note, and here it shows "?").
import { StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import { resolve } from '../../features/links';
import { noteContext } from '../context';
import { followLink } from '../editorCommands';
import { linkAt } from '../linkAt';
import { collectElements, type LiveElement } from './model';
import { renderCell } from './table/render';

/** A part of a footnote's text in the note: a line of its definition, or an inline footnote's text. */
export interface FootnotePart {
  from: number;
  to: number;
}

/** The note's footnotes: their numbers, and where their texts are. */
export class FootnoteIndex {
  private readonly numbers: ReadonlyMap<string, number>;
  private readonly inline: ReadonlyMap<number, number>;
  private readonly definitions: ReadonlyMap<string, readonly FootnotePart[]>;
  constructor(numbers: ReadonlyMap<string, number>, inline: ReadonlyMap<number, number>, definitions: ReadonlyMap<string, readonly FootnotePart[]>) {
    this.numbers = numbers;
    this.inline = inline;
    this.definitions = definitions;
  }

  /** The number a reference to `label` shows, or null when the label has no definition. */
  number(label: string): number | null {
    return this.numbers.get(label) ?? null;
  }

  /** The number of the inline footnote `^[…]` that starts at `pos`. */
  inlineNumber(pos: number): number | null {
    return this.inline.get(pos) ?? null;
  }

  /** Where the text of `label`'s definition is, line by line. */
  definition(label: string): readonly FootnotePart[] | null {
    return this.definitions.get(label) ?? null;
  }

  /** The index after `changes`, which touched no footnote syntax. */
  map(changes: ChangeDesc): FootnoteIndex {
    const inline = new Map<number, number>();
    for (const [pos, n] of this.inline) inline.set(changes.mapPos(pos, 1), n);
    const definitions = new Map<string, FootnotePart[]>();
    for (const [label, parts] of this.definitions) definitions.set(label, parts.map((p) => ({ from: changes.mapPos(p.from, -1), to: changes.mapPos(p.to, 1) })));
    return new FootnoteIndex(this.numbers, inline, definitions);
  }
}

const DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*/;
const REFERENCE = /\[\^([^\]\s]+)\](?!\()|\^\[/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DASHES = /^---[ \t]*$/;

/** `text` with its inline code spans blanked out (same length, so offsets stay). */
function withoutCode(text: string): string {
  return text.includes('`') ? text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => ' '.repeat(m.length)) : text;
}

/** The line number (1-based) of the frontmatter's closing `---`, or 0. */
function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || !DASHES.test(doc.line(1).text)) return 0;
  let n = 1;
  for (const iter = doc.iterLines(2); !iter.next().done; ) {
    n++;
    if (DASHES.test(iter.value)) return n;
  }
  return 0;
}

function scan(doc: Text): FootnoteIndex {
  const definitions = new Map<string, FootnotePart[]>();
  const references: Array<{ label: string | null; pos: number }> = [];
  const skipTo = frontmatterEnd(doc);
  let fence: { ch: string; length: number } | null = null;
  let open: FootnotePart[] | null = null;
  let n = 0;
  let pos = 0;
  for (const iter = doc.iterLines(); !iter.next().done; ) {
    const text = iter.value;
    const from = pos;
    pos += text.length + 1;
    n++;
    if (n <= skipTo) continue;
    const f = FENCE.exec(text);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.length && text.slice(f[0].length).trim() === '') fence = null;
      continue;
    }
    if (f) {
      fence = { ch: f[1][0], length: f[1].length };
      open = null;
      continue;
    }
    let at = 0;
    if (open && text.trim() !== '' && /^(?: {4}|\t)/.test(text)) {
      const indent = /^[ \t]*/.exec(text)![0].length;
      open.push({ from: from + indent, to: from + text.length });
      at = indent;
    } else {
      open = null;
      if (!text.includes('[^') && !text.includes('^[')) continue;
      const d = DEFINITION.exec(text);
      if (d) {
        at = d[0].length;
        if (!definitions.has(d[1])) {
          open = [{ from: from + at, to: from + text.length }];
          definitions.set(d[1], open);
        }
      }
    }
    const rest = withoutCode(text.slice(at));
    for (const m of rest.matchAll(REFERENCE)) references.push({ label: m[1] ?? null, pos: from + at + m.index });
  }
  const numbers = new Map<string, number>();
  const inline = new Map<number, number>();
  let next = 1;
  for (const r of references) {
    if (r.label === null) inline.set(r.pos, next++);
    else if (definitions.has(r.label) && !numbers.has(r.label)) numbers.set(r.label, next++);
  }
  return new FootnoteIndex(numbers, inline, definitions);
}

const indexes = new WeakMap<Text, FootnoteIndex>();

/** The footnotes of `doc`, read from all of it (once per document). */
export function footnoteIndex(doc: Text): FootnoteIndex {
  let index = indexes.get(doc);
  if (!index) {
    index = scan(doc);
    indexes.set(doc, index);
  }
  return index;
}

/** What of a line decides the footnotes: its indentation (or blankness), and its footnote syntax, backticks, fences and delimiters. */
const SHAPE_TOKENS = /\[\^[^\]\s]*\]?:?|\^\[|`+|~{3,}|^---/g;

function shape(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? 'blank' : String(/^[ \t]*/.exec(line)![0].length)) + ':' + (line.match(SHAPE_TOKENS) ?? []).join(' '))
    .join('\n');
}

/**
 * The note's footnotes, kept through edits (ROADMAP 10c): an edit that leaves the shape of its
 * lines alone (typing words, in a footnote's text too) maps the index instead of reading the whole
 * note again. A stale index (null) is read again when a footnote is next shown.
 */
const footnotesField = StateField.define<FootnoteIndex | null>({
  create: () => null,
  update(value, tr) {
    if (!tr.docChanged) return value;
    const previous = value ?? indexes.get(tr.startState.doc) ?? null;
    if (!previous) return null;
    let touches = false;
    const before = tr.startState.doc;
    const after = tr.state.doc;
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      if (!touches) touches = shape(before.sliceString(before.lineAt(fromA).from, before.lineAt(toA).to)) !== shape(after.sliceString(after.lineAt(fromB).from, after.lineAt(toB).to));
    });
    return touches ? null : previous.map(tr.changes);
  },
});

/** The footnotes of the note in `state`. */
export function footnotesOf(state: EditorState): FootnoteIndex {
  return state.field(footnotesField, false) ?? footnoteIndex(state.doc);
}

// ---------- the footnote's text, on hover or tap ----------

/** The footnote (reference or inline) whose range holds `pos`, from the side `side` points to. */
function footnoteAt(state: EditorState, pos: number, side: -1 | 0 | 1 = 0): LiveElement | null {
  const line = state.doc.lineAt(pos);
  for (const el of collectElements(state, [{ from: line.from, to: line.to }])) {
    if (el.kind !== 'footnote' || pos < el.from || pos > el.to) continue;
    if ((pos === el.from && side < 0) || (pos === el.to && side > 0)) continue;
    return el;
  }
  return null;
}

/** The text an element's footnote shows: its definition's lines, or an inline footnote's text. */
function partsOf(state: EditorState, el: LiveElement): readonly FootnotePart[] | null {
  const spec = el.pieces[0]?.widget;
  if (!spec || spec.type !== 'footnote') return null;
  if (spec.label === null) return [{ from: el.from + 2, to: el.to - 1 }];
  return footnotesOf(state).definition(spec.label);
}

/** The tooltip's content: the footnote's text as inline Markdown (links follow on a click). */
function tooltipDom(view: EditorView, parts: readonly FootnotePart[] | null): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-lp-footnote-tooltip';
  if (!parts) {
    dom.classList.add('is-missing');
    dom.textContent = 'This footnote has no text: add a line “[^label]: text”.';
    return dom;
  }
  const note = view.state.facet(noteContext);
  const resolves = (target: string) => !note || resolve(target, note.path(), note.tree().links) !== null;
  parts.forEach((part, i) => {
    if (i > 0) dom.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    span.dataset.from = String(part.from);
    span.appendChild(renderCell(view.state.sliceDoc(part.from, part.to), { resolves }));
    dom.appendChild(span);
  });
  dom.addEventListener('mousedown', (e) => e.preventDefault());
  dom.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-pos]') : null;
    const part = link?.closest<HTMLElement>('[data-from]');
    if (!link || !part) return;
    const hit = linkAt(view.state, Number(part.dataset.from) + Number(link.dataset.pos));
    if (!hit) return;
    e.preventDefault();
    followLink(view, hit);
  });
  return dom;
}

function tooltipFor(el: LiveElement): Tooltip {
  return { pos: el.from, end: el.to, above: true, arrow: false, create: (view) => ({ dom: tooltipDom(view, partsOf(view.state, el)) }) };
}

/** Opens (a position) or closes (null) the footnote tooltip that a tap or click pinned. */
export const showFootnote = StateEffect.define<number | null>();

const pinnedFootnote = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showFootnote)) return e.value;
    if (value === null) return null;
    // Any edit, or a move of the cursor, closes it.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    showTooltip.compute([field], (state) => {
      const pos = state.field(field);
      const el = pos === null ? null : footnoteAt(state, pos, 1);
      return el ? tooltipFor(el) : null;
    }),
});

/**
 * A footnote's text: shown while the mouse rests on its number, and pinned by a click or a tap on
 * it (until the cursor moves, the note changes or Escape).
 */
export function footnoteTooltips(): Extension {
  return [
    footnotesField,
    pinnedFootnote,
    // It closes on an edit: its links know where they are in the note's text as it was.
    hoverTooltip(
      (view, pos, side) => {
        if (view.state.field(pinnedFootnote, false) !== null) return null;
        const el = footnoteAt(view.state, pos, side);
        return el ? tooltipFor(el) : null;
      },
      { hideOnChange: true },
    ),
    keymap.of([
      {
        key: 'Escape',
        run: (view) => {
          if (view.state.field(pinnedFootnote, false) === null) return false;
          view.dispatch({ effects: showFootnote.of(null) });
          return true;
        },
      },
    ]),
  ];
}
