// Blocks of a note and their Obsidian block ids (ROADMAP item 20, DESIGN §6.37): the `[[Note#^`
// picker, `![[Note#^id]]` transclusion, scrolling to a block and the block backlinks all read a
// note through `scanBlocks`. The server's `POST /api/notes/block-id` (API.md §37) only splices an
// id where this scanner says it belongs, after checking that the line is still there.
//
// The rules follow Obsidian: a paragraph, a heading or a list item carries its id at the end of
// its (last own) line, `Some text ^a1b2c3`; a structured block (a table, a quote or callout, a
// code or math block, a whole list) carries it on a line of its own after the block, `^a1b2c3`,
// usually after a blank line.

import { parseMarkdownDestination, splitWikiBody } from './syntax';

export type BlockKind = 'paragraph' | 'heading' | 'list-item' | 'list' | 'quote' | 'callout' | 'table' | 'code' | 'math';

export interface NoteBlock {
  kind: BlockKind;
  /** 0-based first line. */
  start: number;
  /** 0-based last line, inclusive (a list item's nested items included; its own `^id` line excluded). */
  end: number;
  /**
   * Where a new id goes: `end` appends ` ^id` to line `anchor`; `after` puts `^id` on a line of its
   * own after line `anchor` (the block's last line).
   */
  placement: 'end' | 'after';
  anchor: number;
  /** The block's id as written (case kept), or null. */
  id: string | null;
  /** The 0-based line that holds the id, or null. */
  idLine: number | null;
  /** One line of plain text for the picker and the backlinks panel (markers and the id removed). */
  text: string;
  /** Heading level (1–6) of a heading; list depth (0 = top level) of a list item. */
  level: number;
}

/** A block id closing a line (DESIGN §5.5.4). */
export const LINE_BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
/** A line that holds nothing but a block id. */
const STANDALONE_ID = /^\s*\^([A-Za-z0-9-]+)\s*$/;
/** A valid block id (what a `#^…` subpath may name). */
export const BLOCK_ID = /^[A-Za-z0-9-]+$/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const CALLOUT = /^ {0,3}>\s*\[![^\]]+\]/;
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const MATH = /^ {0,3}\$\$/;
const MAX_TEXT = 200;

const isBlank = (line: string) => line.trim() === '';

function indentWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

/** The note's lines without their `\r`. */
export function noteLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The first body line: after a frontmatter block, else 0 (DESIGN §5.5.3). */
function bodyStart(lines: string[]): number {
  if (lines.length < 2 || lines[0].trimEnd() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === '---') return i + 1;
  return 0;
}

/** Plain one-line text of Markdown source: no id, link brackets, emphasis or code marks. */
export function plainText(source: string): string {
  const text = source
    .replace(LINE_BLOCK_ID, '')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
}

function idOf(line: string): string | null {
  return LINE_BLOCK_ID.exec(line)?.[1] ?? null;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    ATX.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    HR.test(line) ||
    MATH.test(line) ||
    (line.includes('|') && next !== undefined && next.includes('-') && TABLE_SEPARATOR.test(next))
  );
}

/** The blocks of a note, in document order. Lines are 0-based over the whole text (LF or CRLF). */
export function scanBlocks(text: string): NoteBlock[] {
  const lines = noteLines(text);
  const blocks: NoteBlock[] = [];
  let i = bodyStart(lines);
  const push = (b: Omit<NoteBlock, 'idLine'> & { idLine?: number | null }) => {
    blocks.push({ ...b, idLine: b.idLine ?? (b.id !== null ? b.anchor : null) });
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // `^id` alone after a block: the previous block's id.
    const standalone = STANDALONE_ID.exec(line);
    if (standalone) {
      const prev = blocks.length ? lastTopBlock(blocks) : null;
      if (prev && prev.id === null && lines.slice(prev.end + 1, i).every(isBlank)) {
        prev.id = standalone[1];
        prev.idLine = i;
      }
      i++;
      continue;
    }

    // Obsidian comments hide their content.
    if (line.trimStart().startsWith('%%')) {
      const rest = line.trimStart().slice(2);
      if (!rest.includes('%%')) {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes('%%')) j++;
        i = j + 1;
      } else i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const ch = fence[1][0];
      const len = fence[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
        if (close && close[1][0] === ch && close[1].length >= len) break;
        j++;
      }
      const end = Math.min(j, lines.length - 1);
      push({ kind: 'code', start: i, end, placement: 'after', anchor: end, id: null, text: plainText(lines[i + 1] ?? '') || 'Code', level: 0 });
      i = end + 1;
      continue;
    }

    if (MATH.test(line)) {
      const single = line.trim().length > 2 && line.trim().endsWith('$$') && line.trim() !== '$$';
      let j = i;
      if (!single) {
        j = i + 1;
        while (j < lines.length && !lines[j].includes('$$')) j++;
        j = Math.min(j, lines.length - 1);
      }
      const inner = single ? line.trim().slice(2, -2) : lines.slice(i + 1, j).join(' ');
      push({ kind: 'math', start: i, end: j, placement: 'after', anchor: j, id: null, text: plainText(inner) || 'Math', level: 0 });
      i = j + 1;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      push({ kind: 'heading', start: i, end: i, placement: 'end', anchor: i, id: idOf(line), text: plainText(atx[2] ?? ''), level: atx[1].length });
      i++;
      continue;
    }

    if (HR.test(line)) {
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      let j = i;
      while (j + 1 < lines.length && QUOTE.test(lines[j + 1])) j++;
      const callout = CALLOUT.test(line);
      const body = lines.slice(i, j + 1).map((l) => l.replace(/^ {0,3}>\s?/, ''));
      const title = callout ? body[0].replace(/^\[![^\]]+\][+-]?\s*/, '') : '';
      const preview = callout ? title || body.slice(1).join(' ') : body.join(' ');
      push({ kind: callout ? 'callout' : 'quote', start: i, end: j, placement: 'after', anchor: j, id: idOf(lines[j]), text: plainText(preview) || 'Quote', level: 0 });
      i = j + 1;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEPARATOR.test(lines[i + 1])) {
      let j = i + 1;
      while (j + 1 < lines.length && !isBlank(lines[j + 1]) && lines[j + 1].includes('|')) j++;
      const header = line.split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
      push({ kind: 'table', start: i, end: j, placement: 'after', anchor: j, id: null, text: plainText(header) || 'Table', level: 0 });
      i = j + 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      i = scanList(lines, i, push);
      continue;
    }

    // A paragraph (or a setext heading).
    let j = i;
    while (j + 1 < lines.length && !isBlank(lines[j + 1]) && !startsBlock(lines[j + 1], lines[j + 2]) && !SETEXT.test(lines[j + 1])) j++;
    if (j + 1 < lines.length && SETEXT.test(lines[j + 1])) {
      const level = lines[j + 1].trim().startsWith('=') ? 1 : 2;
      push({ kind: 'heading', start: i, end: j + 1, placement: 'end', anchor: j, id: idOf(lines[j]), text: plainText(lines.slice(i, j + 1).join(' ')), level });
      i = j + 2;
      continue;
    }
    push({ kind: 'paragraph', start: i, end: j, placement: 'end', anchor: j, id: idOf(lines[j]), text: plainText(lines.slice(i, j + 1).join(' ')), level: 0 });
    i = j + 1;
  }
  return blocks;
}

/** The last block that is not nested in a list (a list's own block comes before its items). */
function lastTopBlock(blocks: NoteBlock[]): NoteBlock {
  const last = blocks[blocks.length - 1];
  if (last.kind !== 'list-item') return last;
  for (let k = blocks.length - 1; k >= 0; k--) if (blocks[k].kind === 'list') return blocks[k];
  return last;
}

/** A list from line `start`: the whole list, then each item. Returns the line after the list. */
function scanList(lines: string[], start: number, push: (b: Omit<NoteBlock, 'idLine'>) => void): number {
  // The list's extent: non-blank lines, and blank lines followed by an item or an indented line.
  let end = start;
  let fence: string | null = null;
  const inFence: boolean[] = [];
  for (let j = start; j < lines.length; j++) {
    const l = lines[j];
    if (j > start && fence === null) {
      if (isBlank(l)) {
        // A blank line continues the list only when an item or an indented line follows.
        let k = j;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k >= lines.length) break;
        const next = lines[k];
        if (indentWidth(next) < 2 && (!LIST_ITEM.test(next) || HR.test(next))) break;
        inFence.push(false);
        continue;
      }
      if (indentWidth(l) === 0 && !LIST_ITEM.test(l) && (ATX.test(l) || FENCE.test(l) || HR.test(l) || QUOTE.test(l))) break;
    }
    inFence.push(fence !== null);
    const f = FENCE.exec(l.trimStart());
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    end = j;
  }
  while (end > start && isBlank(lines[end])) end--;

  const items: Array<{ line: number; indent: number }> = [];
  for (let j = start; j <= end; j++) {
    if (inFence[j - start]) continue;
    const m = LIST_ITEM.exec(lines[j]);
    if (m && !HR.test(lines[j])) items.push({ line: j, indent: indentWidth(m[1]) });
  }
  const listText = plainText(itemText(lines[start]));
  push({ kind: 'list', start, end, placement: 'after', anchor: end, id: null, text: listText || 'List', level: 0 });

  const depths: number[] = [];
  for (let k = 0; k < items.length; k++) {
    const { line, indent } = items[k];
    while (depths.length && depths[depths.length - 1] >= indent) depths.pop();
    const level = depths.length;
    depths.push(indent);
    let itemEnd = end;
    for (let n = k + 1; n < items.length; n++) {
      if (items[n].indent <= indent) {
        itemEnd = items[n].line - 1;
        break;
      }
    }
    while (itemEnd > line && isBlank(lines[itemEnd])) itemEnd--;
    let ownEnd = line;
    while (ownEnd + 1 <= itemEnd && !isBlank(lines[ownEnd + 1]) && !LIST_ITEM.test(lines[ownEnd + 1]) && !inFence[ownEnd + 1 - start] && !FENCE.test(lines[ownEnd + 1].trimStart())) ownEnd++;
    const own = [itemText(lines[line]), ...lines.slice(line + 1, ownEnd + 1)].join(' ');
    push({ kind: 'list-item', start: line, end: itemEnd, placement: 'end', anchor: ownEnd, id: idOf(lines[ownEnd]), text: plainText(own) || 'List item', level });
  }
  return end + 1;
}

/** A list item's text after its marker and checkbox. */
function itemText(line: string): string {
  return line.replace(LIST_ITEM, '').replace(/^\[[^\]]\][ \t]+/, '');
}

/** The block with id `id` (case-insensitive, as Obsidian matches them), or null. */
export function findBlock(blocks: readonly NoteBlock[], id: string): NoteBlock | null {
  const key = id.replace(/^\^/, '').toLowerCase();
  if (!key) return null;
  return blocks.find((b) => b.id !== null && b.id.toLowerCase() === key) ?? null;
}

/** The block a subpath (`^id`, or `Heading#^id`) addresses, or null when it names no block. */
export function blockSubpathId(subpath: string | null | undefined): string | null {
  if (!subpath) return null;
  const last = (subpath.split('#').pop() ?? '').trim();
  return last.startsWith('^') && BLOCK_ID.test(last.slice(1)) ? last.slice(1) : null;
}

/**
 * The Markdown of the block with id `id`, for `![[Note#^id]]`: the paragraph, the list item with
 * its nested items (outdented to the top level), the table, quote or code block, or a heading's
 * whole section, as Obsidian shows them. Null when the note has no such block.
 */
export function extractBlock(text: string, id: string): string | null {
  const blocks = scanBlocks(text);
  const block = findBlock(blocks, id);
  if (!block) return null;
  const lines = noteLines(text);
  if (block.kind === 'heading') {
    let end = lines.length - 1;
    for (const b of blocks) {
      if (b.start > block.end && b.kind === 'heading' && b.level <= block.level) {
        end = b.start - 1;
        break;
      }
    }
    while (end > block.end && isBlank(lines[end])) end--;
    return lines.slice(block.start, end + 1).join('\n');
  }
  const slice = lines.slice(block.start, block.end + 1);
  if (block.kind === 'list-item') {
    const strip = indentWidth(slice[0]);
    return slice.map((l) => outdent(l, strip)).join('\n');
  }
  return slice.join('\n');
}

function outdent(line: string, width: number): string {
  let w = 0;
  let k = 0;
  while (k < line.length && w < width && (line[k] === ' ' || line[k] === '\t')) {
    w += line[k] === '\t' ? 4 - (w % 4) : 1;
    k++;
  }
  return line.slice(k);
}

/** Blocks a `[[Note#^` picker offers: everything except id-less whole lists. */
export function pickableBlocks(blocks: readonly NoteBlock[]): NoteBlock[] {
  return blocks.filter((b) => b.kind !== 'list' || b.id !== null);
}

// ---------- adding an id ----------

/** What `POST /api/notes/block-id` (API.md §37) and a local edit need to place a new id. */
export interface BlockIdRequestFields {
  /** 0-based line of the block's anchor (`NoteBlock.anchor`) when it was read. */
  line: number;
  /** That line's text as read (without `\r`), to find it again if lines moved. */
  lineText: string;
  placement: 'end' | 'after';
}

/** A random 6-character id (lower-case letters and digits), as Obsidian makes them. */
export function newBlockId(taken: Iterable<string> = [], random: () => number = Math.random): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let id = '';
    for (let k = 0; k < 6; k++) id += chars[Math.floor(random() * chars.length)];
    if (!used.has(id) && /[a-z]/.test(id)) return id;
  }
}

/** Every block id in the text (any line ending with one). */
export function blockIdsIn(text: string): string[] {
  const ids: string[] = [];
  for (const line of noteLines(text)) {
    const id = idOf(line);
    if (id) ids.push(id);
  }
  return ids;
}

export type BlockIdEdit =
  | { kind: 'existing'; id: string }
  | { kind: 'insert'; id: string; from: number; insert: string }
  | { kind: 'missing' };

/**
 * Where the id goes in `text` now (the same rules as the server, API.md §37): line `line` when it
 * still reads `lineText`, else the one line that does; a block that already has an id keeps it.
 * The insertion uses the text's own line breaks.
 */
export function planBlockId(text: string, req: BlockIdRequestFields, wanted: string): BlockIdEdit {
  const raw = text.split('\n');
  const lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let line = req.line;
  if (lines[line] !== req.lineText) {
    const hits: number[] = [];
    lines.forEach((l, k) => {
      if (l === req.lineText) hits.push(k);
    });
    if (hits.length !== 1 || req.lineText.trim() === '') return { kind: 'missing' };
    line = hits[0];
  }
  let offset = 0;
  for (let k = 0; k < line; k++) offset += raw[k].length + 1;
  const eol = text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n';
  if (req.placement === 'end') {
    const existing = idOf(lines[line]);
    if (existing) return { kind: 'existing', id: existing };
    const content = lines[line].replace(/[ \t]+$/, '');
    return { kind: 'insert', id: wanted, from: offset + content.length, insert: (content === '' ? '' : ' ') + '^' + wanted };
  }
  // On a line of its own after the block: reuse one that is already there.
  for (let k = line + 1; k < lines.length && k <= line + 2; k++) {
    const m = STANDALONE_ID.exec(lines[k]);
    if (m) return { kind: 'existing', id: m[1] };
    if (!isBlank(lines[k])) break;
  }
  const end = offset + lines[line].length;
  const nextBlank = line + 1 >= lines.length || isBlank(lines[line + 1]);
  const insert = eol + eol + '^' + wanted + (nextBlank ? '' : eol);
  return { kind: 'insert', id: wanted, from: end, insert };
}

// ---------- links to blocks ----------

const RAW_WIKI = /^!?\[\[([^[\]\n]*)\]\]$/;
const RAW_MARKDOWN = /^!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)$/;

/**
 * The block id a link names, from its raw text as written (a backlink's `matched`):
 * `[[Note#^id]]`, `![[Note#^id|x]]`, `[x](Note.md#%5Eid)`. Null for links to a note or a heading.
 */
export function linkedBlockId(raw: string): string | null {
  const wiki = RAW_WIKI.exec(raw);
  if (wiki) return blockSubpathId(splitWikiBody(wiki[1]).subpath);
  const md = RAW_MARKDOWN.exec(raw);
  if (md) return blockSubpathId(parseMarkdownDestination(md[1]).subpath);
  return null;
}
