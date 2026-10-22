// Live Preview tables (DESIGN §6.6.1): a cell's Markdown as DOM for the grid, built from the same
// Lezer parse the editor uses, with the classes Live Preview gives the same markup elsewhere, so a
// cell looks the same shown and being edited. Built with createElement and textContent only, never
// from HTML strings, so nothing in a note can inject markup.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { isInternalDestination, parseMarkdownDestination, splitWikiBody } from '../../../features/syntax';
import { ObsidianSyntax } from '../../obsidianSyntax';
import { embedSpec, type EmbedSpec } from '../model';

/** Block syntax a table cell cannot hold: GFM cells are inline content. */
const BLOCKS = ['LinkReference', 'IndentedCode', 'FencedCode', 'Blockquote', 'HorizontalRule', 'BulletList', 'OrderedList', 'ATXHeading', 'HTMLBlock', 'SetextHeading', 'Table', 'TaskList'];

/** The language of a table cell: the note's inline Markdown and Obsidian syntax, without blocks. */
export const cellLanguage = markdown({
  base: markdownLanguage,
  extensions: [{ ...ObsidianSyntax, parseBlock: [] }, { remove: BLOCKS }],
  completeHTMLTags: false,
});

const cellParser = cellLanguage.language.parser;

export interface CellRenderContext {
  /** Whether an internal link target resolves; unresolved links are dimmed, as in the editor. */
  resolves(target: string): boolean;
  /** An image in a cell (ROADMAP 10b): its element, or null to show its Markdown as typed (other embeds). */
  image?(embed: EmbedSpec): HTMLElement | null;
}

/** What a table cell shows instead of its Markdown (a formula's result, ROADMAP 39). */
export interface CellDisplay {
  text: string;
  className?: string;
  /** Shown on hover (an error's message). */
  title?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–' };

function decodeEntity(raw: string): string {
  const m = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(\w+));$/.exec(raw);
  if (!m) return raw;
  const code = m[1] ? Number(m[1]) : m[2] ? parseInt(m[2], 16) : null;
  if (code !== null) return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  return ENTITIES[m[3]] ?? raw;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A link or tag: `data-pos` is its offset in the cell, for following it. */
function linkElement(className: string, text: string, pos: number): HTMLElement {
  const el = element('span', className, text);
  el.dataset.pos = String(pos);
  return el;
}

/** Appends the text and nodes of `node` between `from` and `to`. */
function appendInner(parent: Node, node: SyntaxNode, src: string, ctx: CellRenderContext, from = node.from, to = node.to): void {
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > pos) parent.appendChild(document.createTextNode(src.slice(pos, child.from)));
    appendNode(parent, child, src, ctx);
    pos = child.to;
  }
  if (pos < to) parent.appendChild(document.createTextNode(src.slice(pos, to)));
}

function wikilinkText(body: string): string {
  const { display, sepFrom } = splitWikiBody(body);
  if (display !== null && display !== '') return display;
  let left = sepFrom >= 0 ? body.slice(0, sepFrom) : body;
  // `[[#Heading]]` shows the heading; `[[Note#Heading]]` shows "Note > Heading", as in the reading view.
  if (left.startsWith('#')) left = left.slice(1);
  return left.split('#').join(' > ');
}

function appendNode(parent: Node, node: SyntaxNode, src: string, ctx: CellRenderContext): void {
  const raw = () => parent.appendChild(document.createTextNode(src.slice(node.from, node.to)));
  switch (node.name) {
    case 'EmphasisMark':
    case 'StrikethroughMark':
    case 'HighlightMark':
    case 'Comment':
      return;
    case 'StrongEmphasis':
    case 'Emphasis':
    case 'Strikethrough':
    case 'Highlight': {
      const tags = { StrongEmphasis: ['strong', 'cm-strong'], Emphasis: ['em', 'cm-em'], Strikethrough: ['s', 'cm-strike'], Highlight: ['mark', 'cm-highlight'] } as const;
      const [tag, className] = tags[node.name];
      const el = element(tag, className);
      appendInner(el, node, src, ctx);
      parent.appendChild(el);
      return;
    }
    case 'InlineCode': {
      const marks = node.getChildren('CodeMark');
      if (marks.length < 2) return void raw();
      parent.appendChild(element('code', 'cm-inline-code', src.slice(marks[0].to, marks[marks.length - 1].from)));
      return;
    }
    case 'Link': {
      const marks = node.getChildren('LinkMark');
      const url = node.getChild('URL');
      if (!url || marks.length < 2 || marks[1].from <= marks[0].to) return void raw();
      const dest = src.slice(url.from, url.to);
      const internal = isInternalDestination(dest) && !dest.startsWith('<');
      const unresolved = internal && !ctx.resolves(parseMarkdownDestination(dest).target);
      const el = linkElement(`cm-lp-link${unresolved ? ' cm-unresolved' : ''}`, '', node.from);
      appendInner(el, node, src, ctx, marks[0].to, marks[1].from);
      parent.appendChild(el);
      return;
    }
    case 'Autolink': {
      const url = node.getChild('URL');
      if (!url) return void raw();
      parent.appendChild(linkElement('cm-lp-link cm-lp-url', src.slice(url.from, url.to), node.from));
      return;
    }
    case 'URL':
      parent.appendChild(linkElement('cm-lp-link cm-lp-url', src.slice(node.from, node.to), node.from));
      return;
    case 'WikiLink': {
      const body = src.slice(node.from + 2, node.to - 2);
      const text = wikilinkText(body);
      if (!node.getChild('WikiLinkTarget') || text === '') return void raw();
      const target = splitWikiBody(body).target;
      parent.appendChild(linkElement(`cm-lp-link${target !== '' && !ctx.resolves(target) ? ' cm-unresolved' : ''}`, text, node.from));
      return;
    }
    case 'Hashtag':
      parent.appendChild(linkElement('cm-hashtag', src.slice(node.from, node.to), node.from));
      return;
    case 'Escape':
      parent.appendChild(document.createTextNode(src.slice(node.from + 1, node.to)));
      return;
    case 'Entity':
      parent.appendChild(document.createTextNode(decodeEntity(src.slice(node.from, node.to))));
      return;
    case 'HTMLTag':
      // `<br>` breaks a line in a cell (GFM tables have no other way); other HTML shows as typed.
      if (/^<br\s*\/?>$/i.test(src.slice(node.from, node.to))) parent.appendChild(document.createElement('br'));
      else raw();
      return;
    case 'Image':
    case 'Embed': {
      // Images show; other embeds (notes, PDFs, media) show as typed: a cell holds a line of text.
      const spec = ctx.image ? embedSpec(node, (from, to) => src.slice(from, to)) : null;
      parent.appendChild((spec && ctx.image?.(spec)) || element('span', 'cm-lp-embed-source', src.slice(node.from, node.to)));
      return;
    }
    default:
      appendInner(parent, node, src, ctx);
  }
}

/** A cell's content as DOM. */
export function renderCell(content: string, ctx: CellRenderContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendInner(fragment, cellParser.parse(content).topNode, content, ctx);
  return fragment;
}

/** A formatted value (a formula's result) in place of the cell's Markdown. */
export function renderDisplay(display: CellDisplay): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const el = element('span', `cm-lp-cell-value${display.className ? ` ${display.className}` : ''}`, display.text);
  if (display.title) el.title = display.title;
  fragment.appendChild(el);
  return fragment;
}
