// A compact port of the server's MarkdownScanner (DESIGN §5.5.2–5.5.5) for the dev mock:
// frontmatter, excluded zones, headings, links, tags and block ids with UTF-16 offsets.
import { parse as parseYaml } from 'yaml';
import { findTags, isInternalDestination, normalizeTag, parseMarkdownDestination, parseWikiBody, WIKILINK_PATTERN } from '../../features/syntax';
import type { HeadingInfo, LinkStyle } from '../types';

export interface ScannedLink {
  raw: string;
  target: string;
  subpath: string | null;
  display: string | null;
  embed: boolean;
  style: LinkStyle;
  line: number;
  from: number;
  to: number;
  /** Range of the target text inside `raw`'s source span (for rewrites). */
  targetFrom: number;
  targetTo: number;
  angle: boolean;
  inFrontmatter: boolean;
}

export interface ScannedTag {
  tag: string;
  line: number;
  from: number;
  to: number;
}

export interface NoteScan {
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  /** End offset of the frontmatter block (0 when there is none). */
  bodyStart: number;
  aliases: string[];
  tags: string[];
  tagOccurrences: ScannedTag[];
  headings: HeadingInfo[];
  links: ScannedLink[];
  blockIds: string[];
  /** Ranges where links and tags are not recognized (code, comments, math, frontmatter). */
  excluded: Array<[number, number]>;
  lineStarts: number[];
}

const MD_LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

export function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function overlaps(ranges: Array<[number, number]>, from: number, to: number): boolean {
  return ranges.some(([a, b]) => from < b && to > a);
}

/** The frontmatter block: its end offset and the index of its closing `---` line. */
export function frontmatterBlock(text: string, lineStarts: number[]): { end: number; closeLine: number } | null {
  const lineText = (i: number) => text.slice(lineStarts[i], (lineStarts[i + 1] ?? text.length + 1) - 1).replace(/\r$/, '');
  if (lineStarts.length < 2 || lineText(0).replace(/\s+$/, '') !== '---') return null;
  for (let i = 1; i < lineStarts.length; i++) {
    if (lineText(i).replace(/\s+$/, '') === '---') return { end: lineStarts[i + 1] ?? text.length, closeLine: i };
  }
  return null;
}

function stringList(value: unknown, splitter: RegExp): string[] {
  if (typeof value === 'string') return value.split(splitter).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map((v) => String(v).trim()).filter(Boolean);
  return [];
}

export function scanNote(text: string): NoteScan {
  const lineStarts = lineStartsOf(text);
  const excluded: Array<[number, number]> = [];
  const fm = frontmatterBlock(text, lineStarts);
  const fmEnd = fm ? fm.end : 0;

  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | null = null;
  const links: ScannedLink[] = [];
  const tagOccurrences: ScannedTag[] = [];

  if (fm) {
    excluded.push([0, fmEnd]);
    const yamlSrc = text.slice(lineStarts[1], lineStarts[fm.closeLine]);
    try {
      const data: unknown = parseYaml(yamlSrc, { schema: 'core', uniqueKeys: false });
      frontmatter = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    } catch (e) {
      frontmatterError = e instanceof Error ? e.message : String(e);
    }
    for (const m of text.slice(0, fmEnd).matchAll(WIKILINK_PATTERN)) {
      const body = parseWikiBody(m[2]);
      links.push({
        raw: m[0],
        ...body,
        embed: m[1] === '!',
        style: 'wiki',
        line: lineAt(lineStarts, m.index),
        from: m.index,
        to: m.index + m[0].length,
        targetFrom: m.index + m[1].length + 2,
        targetTo: m.index + m[1].length + 2 + m[2].length,
        angle: false,
        inFrontmatter: true,
      });
    }
  }

  const aliases = frontmatter ? [...stringList(frontmatter.aliases, /,/), ...stringList(frontmatter.alias, /,/)] : [];
  const fmTags = frontmatter ? [...stringList(frontmatter.tags, /[,\s]+/), ...stringList(frontmatter.tag, /[,\s]+/)] : [];

  // Block-level and multi-line exclusions, line by line.
  let fence: { ch: string; len: number } | null = null;
  let math = false;
  let comment: '%%' | '-->' | null = null;
  const firstLine = fm ? fm.closeLine + 1 : 0;
  const headings: HeadingInfo[] = [];
  const blockIds: string[] = [];
  let prevParagraph: { line: number; text: string } | null = null;

  for (let li = firstLine; li < lineStarts.length; li++) {
    const start = lineStarts[li];
    const end = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
    if (start > text.length) break;
    const line = text.slice(start, end).replace(/\r$/, '');

    if (fence) {
      excluded.push([start, end]);
      const close = new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) fence = null;
      prevParagraph = null;
      continue;
    }
    if (math) {
      excluded.push([start, end]);
      if (line.includes('$$')) math = false;
      prevParagraph = null;
      continue;
    }
    if (!comment) {
      const f = FENCE.exec(line);
      if (f) {
        fence = { ch: f[1][0], len: f[1].length };
        excluded.push([start, end]);
        prevParagraph = null;
        continue;
      }
      if (line.trimStart().startsWith('$$')) {
        excluded.push([start, end]);
        if (!line.trimStart().slice(2).includes('$$')) math = true;
        prevParagraph = null;
        continue;
      }
    }

    // Inline scanning: comments (possibly multi-line) and code spans.
    let pos = 0;
    while (pos <= line.length) {
      if (comment) {
        const idx = line.indexOf(comment, pos);
        if (idx < 0) {
          excluded.push([start + pos, end]);
          break;
        }
        excluded.push([start + pos, start + idx + comment.length]);
        pos = idx + comment.length;
        comment = null;
        continue;
      }
      const rest = line.slice(pos);
      const m = /`+|%%|<!--/.exec(rest);
      if (!m) break;
      const at = pos + m.index;
      if (m[0] === '%%') {
        comment = '%%';
        excluded.push([start + at, start + at + 2]);
        pos = at + 2;
      } else if (m[0] === '<!--') {
        comment = '-->';
        excluded.push([start + at, start + at + 4]);
        pos = at + 4;
      } else {
        const run = m[0];
        const closeIdx = findClosingRun(line, at + run.length, run.length);
        if (closeIdx < 0) {
          pos = at + run.length;
        } else {
          excluded.push([start + at, start + closeIdx + run.length]);
          pos = closeIdx + run.length;
        }
      }
    }

    // Headings and block ids (outside excluded block zones).
    const atx = ATX.exec(line);
    if (atx && !overlaps(excluded, start, start + Math.max(1, atx[1].length))) {
      headings.push({ level: atx[1].length as HeadingInfo['level'], text: (atx[2] ?? '').trim(), line: li });
      prevParagraph = null;
    } else if (SETEXT.test(line) && prevParagraph && prevParagraph.line === li - 1) {
      headings.push({ level: line.trim().startsWith('=') ? 1 : 2, text: prevParagraph.text.trim(), line: li - 1 });
      prevParagraph = null;
    } else if (line.trim() === '') {
      prevParagraph = null;
    } else {
      prevParagraph = { line: li, text: line };
    }
    const bid = BLOCK_ID.exec(line);
    if (bid && !overlaps(excluded, start + bid.index, start + line.length)) blockIds.push(bid[1]);
  }

  // Links in the body.
  const linkRanges: Array<[number, number]> = [];
  for (const m of text.matchAll(WIKILINK_PATTERN)) {
    if (m.index < fmEnd || overlaps(excluded, m.index, m.index + m[0].length)) continue;
    const body = parseWikiBody(m[2]);
    links.push({
      raw: m[0],
      ...body,
      embed: m[1] === '!',
      style: 'wiki',
      line: lineAt(lineStarts, m.index),
      from: m.index,
      to: m.index + m[0].length,
      targetFrom: m.index + m[1].length + 2,
      targetTo: m.index + m[1].length + 2 + m[2].length,
      angle: false,
      inFrontmatter: false,
    });
    linkRanges.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(MD_LINK)) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (from < fmEnd || overlaps(excluded, from, to) || overlaps(linkRanges, from, to)) continue;
    linkRanges.push([from, to]);
    const dest = m[3];
    const angle = dest.startsWith('<');
    if (!angle && !isInternalDestination(dest)) continue;
    const { target, subpath } = parseMarkdownDestination(dest);
    const destAt = m[0].indexOf(dest, m[1].length + m[2].length + 2);
    links.push({
      raw: m[0],
      target,
      subpath,
      display: m[2],
      embed: m[1] === '!',
      style: 'markdown',
      line: lineAt(lineStarts, from),
      from,
      to,
      targetFrom: from + destAt + (angle ? 1 : 0),
      targetTo: from + destAt + dest.length - (angle ? 1 : 0),
      angle,
      inFrontmatter: false,
    });
  }
  links.sort((a, b) => a.from - b.from);

  // Tags in the body, outside exclusions and link ranges.
  for (const t of findTags(text)) {
    if (t.from < fmEnd || overlaps(excluded, t.from, t.to) || overlaps(linkRanges, t.from, t.to)) continue;
    tagOccurrences.push({ tag: t.tag, line: lineAt(lineStarts, t.from), from: t.from, to: t.to });
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  const addTag = (raw: string) => {
    const tag = normalizeTag(raw.replace(/^#/, ''));
    if (tag === null || !/^[^\s!-,.:-@[-^`{-~]+$/u.test(tag)) return;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  };
  fmTags.forEach(addTag);
  tagOccurrences.forEach((t) => addTag(t.tag));

  return {
    frontmatter,
    frontmatterError,
    bodyStart: fmEnd,
    aliases,
    tags,
    tagOccurrences,
    headings,
    links,
    blockIds,
    excluded,
    lineStarts,
  };
}

function findClosingRun(line: string, from: number, len: number): number {
  let i = from;
  while (i < line.length) {
    const idx = line.indexOf('`', i);
    if (idx < 0) return -1;
    let j = idx;
    while (j < line.length && line[j] === '`') j++;
    if (j - idx === len) return idx;
    i = j;
  }
  return -1;
}
