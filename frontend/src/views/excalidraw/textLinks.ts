// The Markdown source of a text element in an Obsidian drawing (ROADMAP item 5, DESIGN §6.8.1).
// In its default "parsed" mode the plugin shows a text's links the way Obsidian renders them:
// `[[Project Plan|plan]]` as "plan", `[[Alice]]` as "Alice" (or "[[Alice]]" with its
// showLinkBrackets setting), behind an optional link or URL prefix, and a transclusion
// `![[Note#^id]]` as the text it embeds. The source keeps the links (`## Text Elements` and the
// JSON's `rawText`); the canvas edits what is shown. These functions carry an edit of the shown
// text over to the source without losing a link, and derive what a source that a rename rewrote
// shows. Pure, like format.ts.
import { diff } from '@codemirror/merge';

/**
 * The plugin's link pattern (REGEX_LINK): `[[target|alias]]` and `[alias](url)`, `!` for a
 * transclusion, and the `{width}` that may follow one. Unlike the plugin's, no part of it can
 * match a bracket, a line break or (in a URL) white space, so that crafted text is scanned in
 * linear time; such links do not work in Obsidian either.
 */
const LINK = /(!)?(\[\[([^|[\]\n]+)(?:\|([^[\]\n]*))?\]\]|\[([^[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\))(\{(\d+)\})?/g;

/** The plugin's link and URL prefixes are an emoji or two; anything longer is not a prefix. */
const MAX_PREFIX = 8;

interface Span {
  from: number;
  to: number;
  transclusion: boolean;
  /** `[[target|alias]]` rather than `[alias](target)`. */
  wiki: boolean;
  target: string;
  alias: string | null;
  /** A transclusion's `{width}`, kept as it is. */
  suffix: string;
}

function linkSpans(raw: string): Span[] {
  const spans: Span[] = [];
  for (const m of raw.matchAll(LINK)) {
    const wiki = m[3] !== undefined;
    spans.push({
      from: m.index,
      to: m.index + m[0].length,
      transclusion: m[1] !== undefined,
      wiki,
      target: wiki ? m[3] : m[6],
      alias: (wiki ? m[4] : m[5]) || null,
      suffix: m[7] ?? '',
    });
  }
  return spans;
}

/** What the plugin shows for a link (`parseLinks`); null for a transclusion, which shows another note's text. */
function shownText(span: Span, brackets: boolean): string | null {
  if (span.transclusion) return null;
  const text = span.alias ?? span.target;
  return brackets ? `[[${text}]]` : text;
}

/** The link the plugin gives a text element: its first link, `[[target]]` or the URL. */
export function firstLink(raw: string): string | null {
  const [span] = linkSpans(raw);
  if (!span) return null;
  return span.wiki ? `[[${span.target}]]` : span.target;
}

/** A stretch of the shown text and the stretch of the source it comes from. */
interface Piece {
  kind: 'prefix' | 'text' | 'link' | 'transclusion';
  from: number;
  to: number;
  rawFrom: number;
  rawTo: number;
  span?: Span;
}

interface Alignment {
  pieces: Piece[];
  brackets: boolean;
  prefix: string;
}

type Part = { kind: 'text' | 'link' | 'transclusion'; rawFrom: number; rawTo: number; shown: string | null; span?: Span };

/** The pieces when the shown text starts at `start` (after a prefix), or null when `parts` do not produce `shown`. */
function place(parts: readonly Part[], shown: string, start: number): Piece[] | null {
  const pieces: Piece[] = [];
  let pos = start;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.shown !== null) {
      if (!shown.startsWith(part.shown, pos)) return null;
      pieces.push({ kind: part.kind, from: pos, to: pos + part.shown.length, rawFrom: part.rawFrom, rawTo: part.rawTo, span: part.span });
      pos += part.shown.length;
      continue;
    }
    // A transclusion shows text from elsewhere: it ends where the known text after it starts.
    let next = '';
    let j = i + 1;
    for (; j < parts.length && parts[j].shown !== null; j++) next += parts[j].shown;
    let end: number;
    if (j === parts.length) {
      end = shown.length - next.length;
      if (end < pos || !shown.endsWith(next)) return null;
    } else {
      end = shown.indexOf(next, pos);
      if (end < 0) return null;
    }
    pieces.push({ kind: part.kind, from: pos, to: end, rawFrom: part.rawFrom, rawTo: part.rawTo, span: part.span });
    pos = end;
  }
  return pos === shown.length ? pieces : null;
}

/** How `raw` produces `shown` under the plugin's display rules, or null when it does not. */
function align(raw: string, shown: string): Alignment | null {
  const spans = linkSpans(raw);
  const prefixable = spans.some((s) => !s.transclusion);
  for (const brackets of [false, true]) {
    const parts: Part[] = [];
    let pos = 0;
    for (const span of spans) {
      if (span.from > pos) parts.push({ kind: 'text', rawFrom: pos, rawTo: span.from, shown: raw.slice(pos, span.from) });
      parts.push({ kind: span.transclusion ? 'transclusion' : 'link', rawFrom: span.from, rawTo: span.to, shown: shownText(span, brackets), span });
      pos = span.to;
    }
    if (pos < raw.length) parts.push({ kind: 'text', rawFrom: pos, rawTo: raw.length, shown: raw.slice(pos) });
    const maxPrefix = prefixable ? Math.min(MAX_PREFIX, shown.length) : 0;
    for (let p = 0; p <= maxPrefix; p++) {
      if (shown.slice(0, p).includes('\n')) break;
      const pieces = place(parts, shown, p);
      if (!pieces) continue;
      const prefix: Piece[] = p > 0 ? [{ kind: 'prefix', from: 0, to: p, rawFrom: 0, rawTo: 0 }] : [];
      return { pieces: [...prefix, ...pieces], brackets, prefix: shown.slice(0, p) };
    }
  }
  return null;
}

/** Words, runs of white space, and single other characters. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
/** Tokens are diffed as characters of the private use area. */
const MAX_TOKENS = 6400;

/**
 * The changes from `before` to `after`, word by word, so that letters two different words happen
 * to share never split a change (a replaced phrase stays one change). One word changed into
 * another is narrowed to the letters that differ, which keeps an edit inside a link's text there.
 */
function changesOf(before: string, after: string): Edit[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  const codes = new Map<string, string>();
  const code = (t: string) => {
    let c = codes.get(t);
    if (c === undefined) codes.set(t, (c = String.fromCharCode(0xe000 + codes.size)));
    return c;
  };
  if (new Set([...a, ...b]).size > MAX_TOKENS) return [{ from: 0, to: before.length, insert: after }];
  const offsets = (tokens: string[]) => {
    const out = [0];
    for (const t of tokens) out.push(out[out.length - 1] + t.length);
    return out;
  };
  const at = offsets(a);
  const bt = offsets(b);
  return diff(a.map(code).join(''), b.map(code).join('')).map((c) => {
    let [from, to, fromB, toB] = [at[c.fromA], at[c.toA], bt[c.fromB], bt[c.toB]];
    if (c.toA - c.fromA === 1 && c.toB - c.fromB === 1) {
      while (from < to && fromB < toB && before[from] === after[fromB]) {
        from++;
        fromB++;
      }
      while (from < to && fromB < toB && before[to - 1] === after[toB - 1]) {
        to--;
        toB--;
      }
    }
    return { from, to, insert: after.slice(fromB, toB) };
  });
}

interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** Applies edits that do not overlap; edits at one position keep their order. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const order = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.from - a.from || b.to - a.to || b.i - a.i);
  let out = text;
  for (const e of order) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/** The link `span` showing `shown` instead: the same target, with `shown` as its alias; null when `shown` cannot be one. */
function relinked(span: Span, shown: string, brackets: boolean): string | null {
  let text = shown;
  if (brackets && text.startsWith('[[') && text.endsWith(']]') && text.length >= 4) text = text.slice(2, -2);
  if (text.includes(']') || text.includes('\n')) return null;
  if (span.wiki) return (text === span.target ? `[[${span.target}]]` : `[[${span.target}|${text}]]`) + span.suffix;
  return `[${text}](${span.target})` + span.suffix;
}

/** Where text typed at `pos` of the shown text goes in the source: outside every link. */
function sourcePosition(pos: number, pieces: readonly Piece[], rawLength: number): number {
  for (const p of pieces) {
    if (p.kind === 'prefix' && pos <= p.to) return 0;
    if (p.from < pos && pos < p.to) return p.kind === 'text' ? p.rawFrom + (pos - p.from) : p.rawTo;
  }
  const next = pieces.find((p) => p.kind !== 'prefix' && p.from === pos);
  return next ? next.rawFrom : rawLength;
}

/**
 * The source of a text whose shown text changed from `before` to `after`, keeping its links. The
 * edit is compared word by word: text typed next to a link goes outside it; a link whose own text
 * was edited (letters of it, or all of it for other words) keeps its target and shows the new text
 * as its alias; a link whose text went with a longer phrase that was deleted or replaced goes with
 * it, as in a rich-text editor. Null when the edit cannot be carried over: `before` does not follow
 * from `raw` by the plugin's rules, an edit changes the text of a transclusion, or a new alias
 * cannot be written.
 */
export function editRaw(raw: string, before: string, after: string): string | null {
  if (before === after) return raw;
  // The plugin's raw mode, or a text without links: the source is what is shown.
  if (raw === before) return after;
  if (linkSpans(raw).length === 0) return null;
  const aligned = align(raw, before);
  if (!aligned) return null;
  const { pieces, brackets } = aligned;
  const edits: Edit[] = [];
  const inLink = new Map<Piece, Edit[]>();
  const editLink = (p: Piece, e: Edit) => inLink.set(p, [...(inLink.get(p) ?? []), e]);
  for (const c of changesOf(before, after)) {
    const hit = c.from === c.to ? pieces.filter((p) => p.from < c.from && c.from < p.to) : pieces.filter((p) => p.from < c.to && c.from < p.to);
    if (hit.length === 1 && (hit[0].kind === 'link' || hit[0].kind === 'transclusion')) {
      // Inside the shown text of one link: that text changes.
      if (hit[0].kind === 'transclusion') return null;
      editLink(hit[0], { from: c.from - hit[0].from, to: c.to - hit[0].from, insert: c.insert });
      continue;
    }
    // Text replaced across pieces: links it covers go, links it cuts into keep what is left of
    // their text, and what was typed goes between them, outside every link.
    for (const p of hit) {
      const from = Math.max(c.from, p.from);
      const to = Math.min(c.to, p.to);
      if (p.kind === 'text') edits.push({ from: p.rawFrom + (from - p.from), to: p.rawFrom + (to - p.from), insert: '' });
      else if (p.kind === 'prefix') continue;
      else if (from === p.from && to === p.to) edits.push({ from: p.rawFrom, to: p.rawTo, insert: '' });
      else if (p.kind === 'transclusion') return null;
      else editLink(p, { from: from - p.from, to: to - p.from, insert: '' });
    }
    if (c.insert !== '') {
      const at = sourcePosition(c.from, pieces, raw.length);
      edits.push({ from: at, to: at, insert: c.insert });
    }
  }
  for (const [p, linkEdits] of inLink) {
    const shown = applyEdits(before.slice(p.from, p.to), linkEdits);
    const markup = shown === '' ? '' : relinked(p.span!, shown, brackets);
    if (markup === null) return null;
    edits.push({ from: p.rawFrom, to: p.rawTo, insert: markup });
  }
  return applyEdits(raw, edits);
}

/**
 * What `raw` shows, by the display rules `oldRaw` was shown with as `oldShown` (a rename rewrote a
 * link in the source); null when that cannot be told, or `raw` has a transclusion. The plugin's raw
 * mode shows the source itself.
 */
export function shownFor(raw: string, oldRaw: string, oldShown: string, mode: 'parsed' | 'raw'): string | null {
  if (mode === 'raw') return raw;
  const aligned = align(oldRaw, oldShown);
  if (!aligned) return null;
  const spans = linkSpans(raw);
  if (spans.some((s) => s.transclusion)) return null;
  let out = '';
  let pos = 0;
  for (const span of spans) {
    out += raw.slice(pos, span.from) + shownText(span, aligned.brackets);
    pos = span.to;
  }
  return (spans.length > 0 ? aligned.prefix : '') + out + raw.slice(pos);
}

/** The links of `raw` that `kept` no longer has, as written. */
export function droppedLinks(raw: string, kept: string): string[] {
  return linkSpans(raw)
    .map((s) => raw.slice(s.from, s.to))
    .filter((link) => !kept.includes(link));
}
