// Reading-view pipeline (DESIGN §6.7): markdown-it with the Obsidian rules, DOMPurify, and a
// post-sanitize pass that builds app-generated elements (images with content-addressed URLs,
// remote-image placeholders). Note, PDF and media embeds are hydrated after insertion (embeds.tsx).
import { footnote } from '@mdit/plugin-footnote';
import { mark } from '@mdit/plugin-mark';
import { tasklist } from '@mdit/plugin-tasklist';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import type { Env, MarkdownIt as Md, StateBlock, StateCore, StateInline, Token } from 'markdown-it';
import type { FileEntry } from '../api/types';
import { splitFrontmatter } from '../features/frontmatter';
import { noteRoute } from '../features/paths';
import { isInternalDestination, isWhitespace, matchWikiLinkAt, parseMarkdownDestination, splitWikiBody, tagBodyLength } from '../features/syntax';

export interface RenderContext {
  sourcePath: string;
  /** Client link resolution over the tree (DESIGN §6.6): synchronous, so there is no flicker. */
  resolve(target: string): FileEntry | null;
  rawUrl(entry: FileEntry): string;
  strictLineBreaks: boolean;
  loadRemoteImages: boolean;
  /** 0 for a note; transclusions render at depth 1, where note embeds become links. */
  depth: number;
}

interface RenderEnv extends Env {
  ctx: RenderContext;
  lineOffset: number;
  /** Lines of the rendered body, for checkbox hashes. */
  lines: string[];
}

// ---------- task lines ----------

export const TASK_PATTERN = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])\]/;

/** FNV-1a hash of a source line, stamped on checkboxes as `data-hash`. */
export function lineHash(line: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The change that toggles the task on 0-based `line`, or null when the line no longer has the
 * expected hash (it moved during the render lag) or is not a task.
 */
export function toggleTaskAtLine(text: string, line: number, expectedHash: string): { from: number; to: number; insert: string } | null {
  let start = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', start);
    if (next < 0) return null;
    start = next + 1;
  }
  const end = text.indexOf('\n', start);
  const src = text.slice(start, end < 0 ? text.length : end);
  if (lineHash(src) !== expectedHash) return null;
  const m = TASK_PATTERN.exec(src);
  if (!m) return null;
  const from = start + m[1].length;
  return { from, to: from + 1, insert: m[2] === ' ' ? 'x' : ' ' };
}

/** True when `next` differs from `prev` only by `[ ]` ⇄ `[x]` task markers. */
export function onlyCheckboxesChanged(prev: string, next: string): boolean {
  if (prev.length !== next.length || prev === next) return false;
  const marks = ' xX';
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] === next[i]) continue;
    if (!marks.includes(prev[i]) || !marks.includes(next[i]) || prev[i - 1] !== '[' || prev[i + 1] !== ']') return false;
  }
  return true;
}

// ---------- markdown-it rules ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const ch = state.src.charCodeAt(start);
  if (ch !== 0x21 && ch !== 0x5b) return false;
  const end = matchWikiLinkAt(state.src, start);
  if (end < 0 || end > state.posMax) return false;
  if (!silent) {
    const embed = ch === 0x21;
    const body = state.src.slice(start + (embed ? 3 : 2), end - 2);
    const split = splitWikiBody(body);
    const token = state.push(embed ? 'obsidian_embed' : 'wikilink', '', 0);
    token.meta = { target: split.target, subpath: split.subpath, display: split.display };
    token.content = state.src.slice(start, end);
  }
  state.pos = end;
  return true;
}

function hashtagRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x23) return false;
  // Never inside a link's label; the shared rule needs whitespace (or the start) before `#`.
  if (state.linkLevel > 0) return false;
  if (start > 0 && !isWhitespace(state.src[start - 1])) return false;
  const len = tagBodyLength(state.src.slice(start + 1, state.posMax));
  if (len === 0) return false;
  if (!silent) {
    const token = state.push('hashtag', '', 0);
    token.content = state.src.slice(start + 1, start + 1 + len);
  }
  state.pos = start + 1 + len;
  return true;
}

function commentInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x25 || state.src.charCodeAt(start + 1) !== 0x25) return false;
  const close = state.src.indexOf('%%', start + 2);
  if (close < 0 || close + 2 > state.posMax) return false;
  if (!silent) state.push('obsidian_comment', '', 0);
  state.pos = close + 2;
  return true;
}

/** `%%` opening a line whose comment does not close on it: hidden up to the closing `%%` (or EOF). */
function commentBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.src.slice(pos, pos + 2) !== '%%') return false;
  const rest = state.src.slice(pos + 2, max);
  const sameLine = rest.indexOf('%%');
  if (sameLine >= 0 && rest.slice(sameLine + 2).trim() !== '') return false;
  if (silent) return true;
  let line = startLine;
  if (sameLine < 0) {
    for (line = startLine + 1; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (text.includes('%%')) break;
    }
  }
  state.line = Math.min(line + 1, endLine);
  const token = state.push('obsidian_comment', '', 0);
  token.map = [startLine, state.line];
  return true;
}

function headingText(inline: Token | undefined): string {
  return (inline?.content ?? '').replace(/\s+/g, ' ').trim();
}

/** data-line on block tokens, data-heading on headings, and checkbox data (line, hash, label). */
function annotate(state: StateCore): void {
  const env = state.env as unknown as RenderEnv;
  const stamp = env.ctx.depth === 0;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (stamp && t.block && t.map && t.nesting >= 0 && t.type !== 'inline') t.attrSet('data-line', String(t.map[0] + env.lineOffset));
    if (t.type === 'heading_open') t.attrSet('data-heading', headingText(tokens[i + 1]));
    if (t.type === 'inline' && t.children && t.map) {
      for (const child of t.children) {
        if (child.type !== 'checkbox_input') continue;
        // A transcluded note's tasks are shown, not toggled (the toggle would be lost).
        if (!stamp) child.attrSet('disabled', 'disabled');
        const line = t.map[0];
        child.attrSet('data-line', String(line + env.lineOffset));
        child.attrSet('data-hash', lineHash(env.lines[line] ?? ''));
        child.attrSet('aria-label', t.content.replace(/^\[[ xX]\]\s*/, '').trim() || 'Task');
      }
    }
  }
}

function obsidianPlugin(md: Md): void {
  md.inline.ruler.before('link', 'wikilink', wikilinkRule);
  md.inline.ruler.before('emphasis', 'obsidian_comment', commentInlineRule);
  md.inline.ruler.push('hashtag', hashtagRule);
  md.block.ruler.before('fence', 'obsidian_comment_block', commentBlockRule, { alt: ['paragraph'] });
  md.core.ruler.push('obsidian_annotate', annotate);

  const r = md.renderer.rules;
  r.obsidian_comment = () => '';
  r.hashtag = (tokens, idx) => {
    const tag = tokens[idx].content;
    return `<a class="tag" href="#" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`;
  };
  r.wikilink = (tokens, idx, _opts, env) => {
    const { ctx } = env as unknown as RenderEnv;
    const { target, subpath, display } = tokens[idx].meta as { target: string; subpath: string | null; display: string | null };
    return internalLink(ctx, target, subpath, display ?? defaultLinkText(target, subpath));
  };
  r.obsidian_embed = (tokens, idx, _opts, env) => {
    const { ctx } = env as unknown as RenderEnv;
    const { target, subpath, display } = tokens[idx].meta as { target: string; subpath: string | null; display: string | null };
    return embedHtml(ctx, target, subpath, display);
  };

  const defaultLinkOpen = r.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  r.link_open = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href');
    const { ctx } = env as unknown as RenderEnv;
    if (typeof href === 'string' && isInternalDestination(href)) {
      const { target, subpath } = parseMarkdownDestination(href);
      const entry = target === '' ? ctx.resolve('') : ctx.resolve(target);
      token.attrSet('href', entry ? noteRoute(entry.path, subpath) : '#');
      token.attrSet('data-href', target + (subpath ? '#' + subpath : ''));
      token.attrJoin('class', entry ? 'internal-link' : 'internal-link is-unresolved');
    } else if (typeof href === 'string') {
      token.attrJoin('class', 'external-link');
    }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  r.image = (tokens, idx, _opts, env) => {
    const token = tokens[idx];
    const { ctx } = env as unknown as RenderEnv;
    const src = String(token.attrGet('src') ?? '');
    const [alt, size] = splitAltSize(token.content);
    if (isInternalDestination(src)) {
      const { target, subpath } = parseMarkdownDestination(src);
      return embedHtml(ctx, target, subpath, size ?? alt ?? null);
    }
    const sizeAttrs = size ? sizeData(size) : '';
    if (!ctx.loadRemoteImages) {
      return `<span class="remote-image-placeholder"${ownMark()} data-src="${escapeHtml(src)}" data-alt="${escapeHtml(alt ?? '')}"${sizeAttrs}>${escapeHtml(alt || 'Remote image')}</span>`;
    }
    return `<span class="image-embed remote-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? '')}" loading="lazy"${size ? imgSizeAttrs(size) : ''}></span>`;
  };
}

/** markdown-it percent-encodes destinations; keep internal ones raw for our own decoding (which keeps `+`). */
function rawDestinations(md: Md): void {
  const normalize = md.normalizeLink.bind(md);
  md.normalizeLink = (url: string) => (isInternalDestination(url) ? url : normalize(url));
  md.validateLink = (url: string) => !/^\s*(javascript|vbscript|file):/i.test(url) && !/^\s*data:(?!image\/(gif|png|jpeg|webp);)/i.test(url);
}

function defaultLinkText(target: string, subpath: string | null): string {
  if (target === '') return subpath ?? '';
  return subpath ? `${target} > ${subpath.replace(/#/g, ' > ')}` : target;
}

function internalLink(ctx: RenderContext, target: string, subpath: string | null, text: string): string {
  const entry = ctx.resolve(target);
  const href = entry ? noteRoute(entry.path, subpath) : '#';
  const dataHref = target + (subpath ? '#' + subpath : '');
  const cls = entry ? 'internal-link' : 'internal-link is-unresolved';
  return `<a class="${cls}" data-href="${escapeHtml(dataHref)}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/** `300` or `300x200` from an embed display or an image alt (`alt|300`). */
const SIZE = /^(\d+)(?:x(\d+))?$/;

function splitAltSize(alt: string): [string | null, string | null] {
  const pipe = alt.lastIndexOf('|');
  if (pipe >= 0 && SIZE.test(alt.slice(pipe + 1).trim())) return [alt.slice(0, pipe) || null, alt.slice(pipe + 1).trim()];
  if (SIZE.test(alt.trim())) return [null, alt.trim()];
  return [alt || null, null];
}

function sizeData(size: string): string {
  const m = SIZE.exec(size);
  if (!m) return '';
  return ` data-width="${m[1]}"${m[2] ? ` data-height="${m[2]}"` : ''}`;
}

function imgSizeAttrs(size: string): string {
  const m = SIZE.exec(size);
  if (!m) return '';
  return ` width="${m[1]}"${m[2] ? ` height="${m[2]}"` : ''}`;
}

function embedHtml(ctx: RenderContext, target: string, subpath: string | null, display: string | null): string {
  const entry = ctx.resolve(target);
  if (!entry) {
    const label = display && !SIZE.test(display) ? display : target;
    return `<a class="internal-link internal-embed is-unresolved" data-href="${escapeHtml(target)}" href="#">${escapeHtml(label)}</a>`;
  }
  const size = display && SIZE.test(display.trim()) ? display.trim() : null;
  const attrs =
    ownMark() +
    ` data-embed-path="${escapeHtml(entry.path)}"` +
    (subpath ? ` data-embed-subpath="${escapeHtml(subpath)}"` : '') +
    (size ? sizeData(size) : display ? ` data-embed-alt="${escapeHtml(display)}"` : '');
  switch (entry.kind) {
    case 'image':
      return `<span class="internal-embed image-embed" data-embed-kind="image"${attrs}></span>`;
    case 'audio':
    case 'video':
    case 'pdf':
      return `<span class="internal-embed ${entry.kind}-embed" data-embed-kind="${entry.kind}"${attrs}></span>`;
    case 'note':
      if (ctx.depth > 0 || subpath?.startsWith('^') || entry.path === ctx.sourcePath) {
        return internalLink(ctx, target, subpath, display ?? defaultLinkText(target, subpath));
      }
      return `<span class="internal-embed note-embed" data-embed-kind="note"${attrs}></span>`;
    default:
      return `<span class="internal-embed file-embed" data-embed-kind="file"${attrs}></span>`;
  }
}

// ---------- parser instances ----------

const parsers = new Map<boolean, Md>();

function parser(breaks: boolean): Md {
  let md = parsers.get(breaks);
  if (!md) {
    md = new MarkdownIt({ html: true, linkify: true, breaks });
    rawDestinations(md);
    md.use(obsidianPlugin).use(mark).use(tasklist, { disabled: false, label: false }).use(footnote);
    parsers.set(breaks, md);
  }
  return md;
}

// ---------- sanitizer ----------

/**
 * Attributes that make the app act on an element (embed hydration, image building, transclusion
 * sources, click-to-load placeholders). Raw HTML in a note must not set them: a forged
 * `data-embed-kind="note"` would transclude without the depth and cycle guard (notes are
 * untrusted content, DESIGN §6.7). The renderer marks the elements it creates with a per-render
 * secret (`data-app`); the sanitizer strips these attributes from every other element.
 */
const RESERVED_ATTRS = [
  'data-embed-kind',
  'data-embed-path',
  'data-embed-subpath',
  'data-embed-alt',
  'data-embed-root',
  'data-embedded-in',
  'data-hydrated',
  'data-source',
  'data-width',
  'data-height',
  'data-src',
  'data-alt',
];
const OWN_ATTR = 'data-app';

interface RenderPass {
  nonce: string;
  loadRemoteImages: boolean;
}

/** The render in progress (renderNote is synchronous). */
let pass: RenderPass | null = null;

function ownMark(): string {
  return pass ? ` ${OWN_ATTR}="${pass.nonce}"` : '';
}

function newNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const CSS_URL = /url\s*\(|image-set\s*\(/i;

let purifier: ReturnType<typeof DOMPurify> | null = null;

function purify(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'input' || !(node instanceof Element)) return;
    const isTaskCheckbox = node.getAttribute('type') === 'checkbox' && node.classList.contains('task-list-item-checkbox');
    if (!isTaskCheckbox) node.parentNode?.removeChild(node);
  });
  p.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    const own = pass !== null && node.getAttribute(OWN_ATTR) === pass.nonce;
    node.removeAttribute(OWN_ATTR);
    if (!own) for (const name of RESERVED_ATTRS) node.removeAttribute(name);
    const blockRemote = pass !== null && !pass.loadRemoteImages;
    const style = node.getAttribute('style');
    if (style) {
      const cleaned = style
        .split(';')
        .filter((decl) => {
          const [prop, value = ''] = decl.split(':').map((s) => s.trim().toLowerCase());
          if (prop === 'z-index') return false;
          if (prop === 'position' && /fixed|sticky/.test(value)) return false;
          // "Load remote images: off" covers CSS backgrounds as well (tracking pixels).
          if (blockRemote && CSS_URL.test(decl)) return false;
          return decl.trim() !== '';
        })
        .join(';');
      if (cleaned) node.setAttribute('style', cleaned);
      else node.removeAttribute('style');
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
  purifier = p;
  return p;
}

const SANITIZE_CONFIG = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  ADD_ATTR: ['target'],
  RETURN_DOM_FRAGMENT: true as const,
};

// ---------- post-sanitize pass ----------

/**
 * "Load remote images: off" (DESIGN §6.7) for raw HTML too: `<img>` from other sites becomes the
 * same click-to-load placeholder as a Markdown image, and remote media sources are dropped, so
 * opening a clipped note fetches nothing from other hosts.
 */
function blockRemoteMedia(fragment: DocumentFragment): void {
  for (const img of fragment.querySelectorAll('img')) {
    const srcset = img.getAttribute('srcset');
    if (srcset !== null && REMOTE_URL.test(srcset)) img.removeAttribute('srcset');
    const src = img.getAttribute('src') ?? '';
    if (!REMOTE_URL.test(src)) continue;
    const placeholder = document.createElement('span');
    placeholder.className = 'remote-image-placeholder';
    placeholder.dataset.src = src;
    placeholder.dataset.alt = img.getAttribute('alt') ?? '';
    const width = img.getAttribute('width');
    if (width && /^\d+$/.test(width)) placeholder.dataset.width = width;
    placeholder.textContent = img.getAttribute('alt') || 'Remote image';
    img.replaceWith(placeholder);
  }
  for (const el of fragment.querySelectorAll('video, audio, source, track, image, feImage, use, [background]')) {
    for (const name of ['src', 'srcset', 'poster', 'background', 'href', 'xlink:href']) {
      const value = el.getAttribute(name);
      if (value !== null && REMOTE_URL.test(value)) el.removeAttribute(name);
    }
  }
}

function buildImages(fragment: DocumentFragment, ctx: RenderContext): void {
  for (const el of fragment.querySelectorAll<HTMLElement>('[data-embed-kind="image"]')) {
    const entry = ctx.resolve(el.dataset.embedPath ?? '');
    if (!entry) continue;
    const img = document.createElement('img');
    img.src = ctx.rawUrl(entry);
    img.alt = el.dataset.embedAlt ?? entry.basename;
    img.loading = 'lazy';
    img.decoding = 'async';
    const width = el.dataset.width;
    const height = el.dataset.height;
    if (width) img.width = Number(width);
    if (height) {
      // An explicit WxH keeps its box; the image is letterboxed rather than distorted.
      img.height = Number(height);
      img.style.height = `${Number(height)}px`;
      img.style.objectFit = 'contain';
    }
    if (!width && !height) el.classList.add('is-reserving');
    el.appendChild(img);
  }
}

export interface RenderResult {
  fragment: DocumentFragment;
  /** The frontmatter source, for the properties table. */
  frontmatter: string | null;
  lineOffset: number;
}

/** Renders note text (LF) into a sanitized fragment whose top-level children are the blocks. */
export function renderNote(text: string, ctx: RenderContext): RenderResult {
  const split = splitFrontmatter(text);
  const env: RenderEnv = { ctx, lineOffset: split.lineOffset, lines: split.body.split('\n') };
  const previous = pass;
  pass = { nonce: newNonce(), loadRemoteImages: ctx.loadRemoteImages };
  let fragment: DocumentFragment;
  try {
    const html = parser(!ctx.strictLineBreaks).render(split.body, env);
    fragment = purify().sanitize(html, SANITIZE_CONFIG) as DocumentFragment;
  } finally {
    pass = previous;
  }
  if (!ctx.loadRemoteImages) blockRemoteMedia(fragment);
  buildImages(fragment, ctx);
  return { fragment, frontmatter: split.yaml, lineOffset: split.lineOffset };
}

/** Renders to an HTML string (tests, transclusion previews). */
export function renderNoteHtml(text: string, ctx: RenderContext): string {
  const div = document.createElement('div');
  div.appendChild(renderNote(text, ctx).fragment);
  return div.innerHTML;
}

/** The section under the heading addressed by `subpath` (for `![[Note#Heading]]`), or null. */
export function extractSection(text: string, subpath: string): string | null {
  const wanted = (subpath.split('#').pop() ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!wanted) return null;
  const lines = text.split('\n');
  let fence: string | null = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!h) continue;
    if (start < 0) {
      if (h[2].replace(/\s+/g, ' ').trim().toLowerCase() === wanted) {
        start = i;
        level = h[1].length;
      }
    } else if (h[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}
