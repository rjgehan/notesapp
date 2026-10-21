// Flashcards in notes (DESIGN §6.34), in the syntax of Obsidian's Spaced Repetition plugin, so a
// vault keeps working in both apps:
//
//   Question::Answer                 one card          Question:::Answer   two cards (both ways)
//   Question lines / ? / answer      one card          ... / ?? / ...      two cards (both ways)
//   A ==cloze== deletion             one card per deletion; `==x==^[hint]` shows a hint, and
//                                    `==x==[^1]` groups deletions with the same number
//
// A multi-line card or a cloze is a paragraph: it ends at a blank line (fenced code inside it may
// hold blank lines). Decks are flashcard tags: the note's frontmatter tags, then each line of tags
// sets the deck for the cards after it, and tags at the start of a card's first line apply to that
// card only. With `foldersAsDecks` the note's folder is the deck. Cards inside code, `%%comments%%`
// and HTML comments are ignored, and the plugin's `<!--SR:...-->` scheduling comments are dropped.
import { parseFrontmatter, splitFrontmatter } from '../features/frontmatter';
import { findTags } from '../features/syntax';
import { cardId, frontHint, normalizeCardText, SR_COMMENT } from './ids';

export type CardKind = 'basic' | 'reverse' | 'cloze';

export interface ParsedCard {
  id: string;
  kind: CardKind;
  /** Markdown shown before the answer. */
  front: string;
  /** Markdown of the answer (basic, reverse) or of the whole text with the deletion shown (cloze). */
  back: string;
  path: string;
  /** 0-based line of the card's first line in the note. */
  line: number;
  /** Deck names: tags without `#` (`flashcards/bio`), or the folder with `foldersAsDecks`. */
  decks: string[];
  /** The headings the card is under, outermost first. */
  context: string[];
  /** Cards made from the same text (both sides, the deletions of one paragraph) share this. */
  sibling: string;
  /** The start of the question, on one line (the server's `front` hint). */
  hint: string;
}

export interface ParseOptions {
  tags: readonly string[];
  foldersAsDecks: boolean;
}

type Kind = 'text' | 'code' | 'hidden';

interface Line {
  /** The line with SR comments removed. */
  text: string;
  /** `text` with inline code, comments and wikilinks masked (same length), for finding markers. */
  mask: string;
  kind: Kind;
  /** 0-based line in the note. */
  n: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^#{1,6}[ \t]+(.*?)[ \t#]*$/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/;
const CLOZE = /==(?!=)(.+?)==(?:\^\[([^\]\n]*)\])?(?:\[\^(\d+)\])?/g;
const MASK = '\u0001';

/** Same-length mask of `text` where inline code, comments and wikilinks are blanked. */
export function maskLine(text: string): string {
  const blank = (m: string) => MASK.repeat(m.length);
  return text
    .replace(/(`+)[^`]*?\1/g, blank)
    .replace(/%%.*?%%/g, blank)
    .replace(/<!--.*?-->/g, blank)
    .replace(/\[\[[^[\]\n]*\]\]/g, blank);
}

function classify(body: string, offset: number): Line[] {
  const out: Line[] = [];
  let fence: { ch: string; len: number } | null = null;
  let math = false;
  let percent = false;
  let html = false;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/\r$/, '').replace(SR_COMMENT, '');
    let kind: Kind = 'text';
    if (fence) {
      kind = 'code';
      const close = FENCE.exec(text);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len && text.trim() === close[1]) fence = null;
    } else if (math) {
      kind = 'code';
      if (text.trim().endsWith('$$')) math = false;
    } else if (percent) {
      kind = 'hidden';
      if ((text.match(/%%/g) ?? []).length % 2 === 1) percent = false;
    } else if (html) {
      kind = 'hidden';
      if (text.includes('-->')) html = false;
    } else {
      const open = FENCE.exec(text);
      const trimmed = text.trim();
      if (open) {
        fence = { ch: open[1][0], len: open[1].length };
        kind = 'code';
      } else if (trimmed.startsWith('$$') && !(trimmed.length > 2 && trimmed.endsWith('$$'))) {
        math = true;
        kind = 'code';
      } else if ((text.match(/%%/g) ?? []).length % 2 === 1) {
        percent = true;
        kind = 'hidden';
      } else {
        const stripped = text.replace(/<!--.*?-->/g, '');
        if (stripped.includes('<!--')) {
          html = true;
          kind = 'hidden';
        }
      }
    }
    out.push({ text, mask: kind === 'text' ? maskLine(text) : text, kind, n: i + offset });
  }
  return out;
}

function isFlashcardTag(tag: string, roots: readonly string[]): boolean {
  const t = tag.toLowerCase();
  return roots.some((r) => {
    const root = r.toLowerCase().replace(/^#/, '');
    return t === root || t.startsWith(root + '/');
  });
}

/** Tags in a line, outside masked regions. */
function lineTags(line: Line): { tag: string; from: number; to: number }[] {
  return findTags(line.mask).map((t) => ({ tag: t.tag, from: t.from, to: t.to }));
}

/** True for a line holding only tags (a deck line). */
function onlyTags(line: Line): boolean {
  if (line.kind !== 'text') return false;
  const tags = lineTags(line);
  if (tags.length === 0) return false;
  let rest = line.mask;
  for (const t of [...tags].reverse()) rest = rest.slice(0, t.from) + rest.slice(t.to);
  return rest.trim() === '';
}

/** Flashcard tags at the very start of a line (question-specific decks), and the text after them. */
function leadingDecks(text: string, mask: string, roots: readonly string[]): { decks: string[]; text: string } {
  const decks: string[] = [];
  let pos = 0;
  for (const t of findTags(mask)) {
    if (mask.slice(pos, t.from).trim() !== '') break;
    if (!isFlashcardTag(t.tag, roots)) break;
    decks.push(t.tag);
    pos = t.to;
  }
  return decks.length ? { decks, text: text.slice(pos).replace(/^\s+/, '') } : { decks, text };
}

function frontmatterTags(yaml: string | null): string[] {
  if (yaml === null) return [];
  const data = parseFrontmatter(yaml).data;
  if (!data) return [];
  const raw = data.tags ?? data.tag;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  return list.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().replace(/^#/, ''));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The blank shown for an asked deletion. */
export function clozeBlank(hint: string | null): string {
  return `<span class="fc-cloze">[${hint ? escapeHtml(hint) : '...'}]</span>`;
}

interface Deletion {
  line: number; // index into the block
  from: number;
  to: number;
  text: string;
  hint: string | null;
  group: string;
}

/** Parses the cards of one note. */
export function parseCards(path: string, rawText: string, opts: ParseOptions): ParsedCard[] {
  const text = rawText.replace(/\r\n/g, '\n');
  const split = splitFrontmatter(text);
  const lines = classify(split.body, split.lineOffset);
  const roots = opts.tags.length ? opts.tags : ['flashcards'];
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  // The note's own decks: its first flashcard tags, for cards before any deck line.
  const fmDecks = frontmatterTags(split.yaml).filter((t) => isFlashcardTag(t, roots));
  let noteDecks = fmDecks;
  if (noteDecks.length === 0) {
    for (const l of lines) {
      if (l.kind !== 'text') continue;
      const found = lineTags(l).map((t) => t.tag).filter((t) => isFlashcardTag(t, roots));
      if (found.length) {
        noteDecks = found;
        break;
      }
    }
  }
  let current: string[] = fmDecks;
  const context: string[] = [];
  const cards: ParsedCard[] = [];
  const seen = new Set<string>();

  const decksFor = (specific: string[]): string[] => {
    if (opts.foldersAsDecks) return [folder];
    if (specific.length) return specific;
    return current.length ? current : noteDecks;
  };
  const push = (card: Omit<ParsedCard, 'path' | 'context'>) => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    cards.push({ ...card, path, context: [...context] });
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'hidden' || (l.kind === 'text' && l.text.trim() === '')) {
      i++;
      continue;
    }
    if (l.kind === 'text') {
      const h = HEADING.exec(l.text);
      if (h) {
        const level = /^#+/.exec(l.text)![0].length;
        context.length = Math.min(context.length, level - 1);
        while (context.length < level - 1) context.push('');
        context.push(h[1].trim());
        i++;
        continue;
      }
      if (onlyTags(l)) {
        const decks = lineTags(l).map((t) => t.tag).filter((t) => isFlashcardTag(t, roots));
        if (decks.length) current = decks;
        i++;
        continue;
      }
    }
    // A paragraph: up to the next blank line, hidden line, heading or deck line (code lines belong to it).
    let end = i;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (next.kind === 'code') {
        end++;
        continue;
      }
      if (next.kind === 'hidden' || next.text.trim() === '' || HEADING.test(next.text) || onlyTags(next)) break;
      end++;
    }
    parseBlock(lines.slice(i, end + 1), roots, decksFor, push);
    // Tags inside the paragraph's prose move the deck for the cards after it.
    for (const b of lines.slice(i, end + 1)) {
      if (b.kind !== 'text') continue;
      const lead = leadingDecks(b.text, b.mask, roots);
      const decks = lineTags(b)
        .map((t) => t.tag)
        .filter((t) => isFlashcardTag(t, roots) && !lead.decks.includes(t));
      if (decks.length) current = decks;
    }
    i = end + 1;
  }
  return cards;
}

function parseBlock(
  block: Line[],
  roots: readonly string[],
  decksFor: (specific: string[]) => string[],
  push: (card: Omit<ParsedCard, 'path' | 'context'>) => void,
): void {
  const sibling = (n: number) => `${n}`;
  let seg = 0;
  let emitted = false;
  for (let k = 0; k < block.length; k++) {
    const l = block[k];
    if (l.kind !== 'text') continue;
    const trimmed = l.text.trim();
    if ((trimmed === '?' || trimmed === '??') && k > seg && k < block.length - 1) {
      const frontLines = block.slice(seg, k).map((x) => x.text);
      const lead = leadingDecks(frontLines[0], block[seg].mask, roots);
      frontLines[0] = lead.text;
      const front = frontLines.join('\n').trim();
      const back = block
        .slice(k + 1)
        .map((x) => x.text)
        .join('\n')
        .trim();
      if (front && back) {
        const decks = decksFor(lead.decks);
        const sib = sibling(block[seg].n);
        push({ id: cardId('qa', normalizeCardText(front)), kind: 'basic', front, back, line: block[seg].n, decks, sibling: sib, hint: frontHint(front) });
        if (trimmed === '??') {
          push({ id: cardId('rev', normalizeCardText(back)), kind: 'reverse', front: back, back: front, line: block[seg].n, decks, sibling: sib, hint: frontHint(back) });
        }
      }
      return;
    }
    const sep = l.mask.indexOf('::');
    if (sep >= 0) {
      const reversed = l.mask.startsWith(':::', sep);
      const lead = leadingDecks(l.text, l.mask, roots);
      const shift = l.text.length - lead.text.length;
      const at = sep - shift;
      const left = lead.text.slice(0, Math.max(0, at)).replace(LIST_MARKER, '').trim();
      const right = lead.text.slice(at + (reversed ? 3 : 2)).trim();
      seg = k + 1;
      if (!left || !right || at < 0) continue;
      const decks = decksFor(lead.decks);
      const sib = sibling(l.n);
      push({ id: cardId('qa', normalizeCardText(left)), kind: 'basic', front: left, back: right, line: l.n, decks, sibling: sib, hint: frontHint(left) });
      if (reversed) {
        push({ id: cardId('rev', normalizeCardText(right)), kind: 'reverse', front: right, back: left, line: l.n, decks, sibling: sib, hint: frontHint(right) });
      }
      emitted = true;
    }
  }
  if (!emitted) parseCloze(block, roots, decksFor, push);
}

function parseCloze(
  block: Line[],
  roots: readonly string[],
  decksFor: (specific: string[]) => string[],
  push: (card: Omit<ParsedCard, 'path' | 'context'>) => void,
): void {
  const deletions: Deletion[] = [];
  const texts = block.map((l) => l.text);
  const lead = block[0].kind === 'text' ? leadingDecks(block[0].text, block[0].mask, roots) : { decks: [], text: block[0].text };
  const leadShift = texts[0].length - lead.text.length;
  const counts = new Map<string, number>();
  block.forEach((l, k) => {
    if (l.kind !== 'text') return;
    for (const m of l.mask.matchAll(CLOZE)) {
      if (k === 0 && m.index < leadShift) continue;
      const from = m.index;
      const to = from + m[0].length;
      const inner = l.text.slice(from + 2, from + 2 + m[1].length);
      if (inner.trim() === '') continue;
      const hint = m[2] !== undefined ? l.text.slice(from + 2 + m[1].length + 4, from + 2 + m[1].length + 4 + m[2].length) : null;
      const n = counts.get(inner) ?? 0;
      counts.set(inner, n + 1);
      deletions.push({ line: k, from, to, text: inner, hint, group: m[3] !== undefined ? `#${m[3]}` : `${inner}\u0000${n}` });
    }
  });
  if (deletions.length === 0) return;
  // Classic clozes: deletions with the same number are asked together; one without asks alone.
  const groups = new Map<string, Deletion[]>();
  for (const d of deletions) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  const render = (asked: Set<Deletion> | null, side: 'front' | 'back' | 'plain'): string => {
    const out = texts.map((t) => t);
    for (const d of [...deletions].reverse()) {
      let replacement = d.text;
      if (asked?.has(d)) replacement = side === 'front' ? clozeBlank(d.hint) : `==${d.text}==`;
      out[d.line] = out[d.line].slice(0, d.from) + replacement + out[d.line].slice(d.to);
    }
    out[0] = out[0].slice(leadShift);
    return out.join('\n').trim();
  };
  const plain = normalizeCardText(render(null, 'plain'));
  const decks = decksFor(lead.decks);
  const sib = `${block[0].n}`;
  for (const [key, group] of groups) {
    const asked = new Set(group);
    const front = render(asked, 'front');
    push({
      id: cardId('cloze', plain, key),
      kind: 'cloze',
      front,
      back: render(asked, 'back'),
      line: block[0].n,
      decks,
      sibling: sib,
      hint: frontHint(front.replace(/<span class="fc-cloze">\[(.*?)\]<\/span>/g, '[$1]')),
    });
  }
}
