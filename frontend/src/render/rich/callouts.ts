// Obsidian callouts (ROADMAP item 3, DESIGN §6.7): `> [!type]` blockquotes become callouts, with
// `+`/`-` folding, custom titles, `|metadata`, nesting, and every Obsidian type and alias. Unknown
// types render with the note style and keep their own `data-callout` value, as in Obsidian, so CSS
// snippets written for Obsidian keep working.
import type { MarkdownIt as Md, StateCore, Token } from 'markdown-it';
import { escapeHtml } from './html';

export interface CalloutHeader {
  /** Lowercased type as written (`faq`, `my-type`). */
  type: string;
  /** The built-in kind it is styled as (`question` for `faq`; `note` for unknown types). */
  kind: CalloutKind;
  /** `+` foldable and open, `-` foldable and closed, null not foldable. */
  fold: '+' | '-' | null;
  /** The custom title (Markdown source), or null for the default title. */
  title: string | null;
  /** The text after `|` in `[!type|metadata]`, or null. */
  metadata: string | null;
}

export type CalloutKind =
  | 'note'
  | 'abstract'
  | 'info'
  | 'todo'
  | 'tip'
  | 'success'
  | 'question'
  | 'warning'
  | 'failure'
  | 'danger'
  | 'bug'
  | 'example'
  | 'quote';

/** Every Obsidian callout type and alias, mapped to the kind it is styled as. */
export const CALLOUT_KINDS: Readonly<Record<string, CalloutKind>> = {
  note: 'note',
  abstract: 'abstract',
  summary: 'abstract',
  tldr: 'abstract',
  info: 'info',
  todo: 'todo',
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'success',
  check: 'success',
  done: 'success',
  question: 'question',
  help: 'question',
  faq: 'question',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  failure: 'failure',
  fail: 'failure',
  missing: 'failure',
  danger: 'danger',
  error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote',
  cite: 'quote',
};

const HEADER = /^\[!([^\]|\s]+)(?:\|([^\]]*))?\]([+-]?)(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * Parses the first line of a blockquote's text (without the `>` markers), e.g.
 * `[!faq]- Why? ` → `{type: 'faq', kind: 'question', fold: '-', title: 'Why?'}`. Null when the line
 * is not a callout header.
 */
export function parseCalloutHeader(line: string): CalloutHeader | null {
  const m = HEADER.exec(line);
  if (!m) return null;
  const type = m[1].toLowerCase();
  return {
    type,
    kind: CALLOUT_KINDS[type] ?? 'note',
    fold: m[3] === '+' || m[3] === '-' ? m[3] : null,
    title: m[4] ? m[4] : null,
    metadata: m[2] !== undefined ? m[2].trim() : null,
  };
}

/** The title shown when none is given: the type with its first letter capitalized (`Faq`), as in Obsidian. */
export function defaultCalloutTitle(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

// ---------- HTML (shared by the markdown-it rules and renderCallout) ----------

function openHtml(h: CalloutHeader, attrs = ''): string {
  const tag = h.fold ? 'details' : 'div';
  return (
    `<${tag} class="callout${h.fold ? ' is-collapsible' : ''}" data-callout="${escapeHtml(h.type)}"` +
    (h.fold ? ` data-callout-fold="${h.fold}"` : '') +
    (h.metadata ? ` data-callout-metadata="${escapeHtml(h.metadata)}"` : '') +
    attrs +
    (h.fold === '+' ? ' open' : '') +
    '>'
  );
}

function titleOpenHtml(h: CalloutHeader): string {
  return (
    `<${h.fold ? 'summary' : 'div'} class="callout-title"><span class="callout-icon" aria-hidden="true"></span><span class="callout-title-inner">` +
    (h.title === null ? escapeHtml(defaultCalloutTitle(h.type)) : '')
  );
}

function titleCloseHtml(h: CalloutHeader): string {
  return h.fold ? '</span><span class="callout-fold" aria-hidden="true"></span></summary>' : '</span></div>';
}

const CONTENT_OPEN = '<div class="callout-content">';
const CONTENT_CLOSE = '</div>';

function closeHtml(h: CalloutHeader): string {
  return h.fold ? '</details>' : '</div>';
}

/**
 * Builds a callout element (for Live Preview widgets and other non-markdown-it callers). `title`
 * replaces the default title; `content` is appended to `.callout-content`. Both are trusted nodes:
 * sanitize them first if they came from note HTML.
 */
export function renderCallout(header: CalloutHeader, title?: Node | string | null, content?: Node | null): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = openHtml(header) + titleOpenHtml(header) + titleCloseHtml(header) + CONTENT_OPEN + CONTENT_CLOSE + closeHtml(header);
  const el = template.content.firstElementChild as HTMLElement;
  if (title !== undefined && title !== null) el.querySelector('.callout-title-inner')!.replaceChildren(title);
  if (content) el.querySelector('.callout-content')!.append(content);
  return el;
}

// ---------- markdown-it plugin ----------

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}

/**
 * Core rule, run after block parsing and before inline parsing: rewrites each blockquote whose first
 * paragraph starts with a callout header into callout tokens. The header line becomes the title (an
 * inline token, so the title may hold Markdown); the rest of that paragraph stays as the first body
 * paragraph. Nested callouts are blockquotes too, so they are found by the same pass.
 */
function calloutRule(state: StateCore): void {
  const tokens = state.tokens;
  const headers = new Map<Token, CalloutHeader>();
  const closes = new Map<Token, CalloutHeader>();
  const stack: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'blockquote_open') {
      stack.push(t);
      const inline = tokens[i + 2];
      if (tokens[i + 1]?.type === 'paragraph_open' && inline?.type === 'inline') {
        const header = parseCalloutHeader(firstLine(inline.content));
        if (header) headers.set(t, header);
      }
    } else if (t.type === 'blockquote_close') {
      const open = stack.pop();
      const header = open ? headers.get(open) : undefined;
      if (header) closes.set(t, header);
    }
  }
  if (headers.size === 0) return;

  const out: Token[] = [];
  const token = (type: string, tag: string, nesting: 1 | 0 | -1, header: CalloutHeader, level: number) => {
    const t = new state.Token(type, tag, nesting);
    t.meta = { header };
    t.block = true;
    t.level = level;
    return t;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const header = t.type === 'blockquote_open' ? headers.get(t) : undefined;
    if (header) {
      const open = token('callout_open', header.fold ? 'details' : 'div', 1, header, t.level);
      open.map = t.map;
      out.push(open, token('callout_title_open', header.fold ? 'summary' : 'div', 1, header, t.level + 1));
      const paragraphOpen = tokens[i + 1];
      const inline = tokens[i + 2];
      const paragraphClose = tokens[i + 3];
      const line = paragraphOpen.map?.[0] ?? t.map?.[0] ?? 0;
      if (header.title !== null) {
        const title = new state.Token('inline', '', 0);
        title.content = header.title;
        title.children = [];
        title.map = [line, line + 1];
        title.level = t.level + 2;
        out.push(title);
      }
      out.push(token('callout_title_close', header.fold ? 'summary' : 'div', -1, header, t.level + 1));
      out.push(token('callout_content_open', 'div', 1, header, t.level + 1));
      const nl = inline.content.indexOf('\n');
      if (nl >= 0) {
        // The header shares its paragraph with body text: keep the rest as the first paragraph.
        inline.content = inline.content.slice(nl + 1);
        if (paragraphOpen.map) paragraphOpen.map = [paragraphOpen.map[0] + 1, paragraphOpen.map[1]];
        if (inline.map) inline.map = [inline.map[0] + 1, inline.map[1]];
        out.push(paragraphOpen, inline, paragraphClose);
      }
      i += 3;
      continue;
    }
    const closing = t.type === 'blockquote_close' ? closes.get(t) : undefined;
    if (closing) {
      out.push(token('callout_content_close', 'div', -1, closing, t.level + 1), token('callout_close', closing.fold ? 'details' : 'div', -1, closing, t.level));
      continue;
    }
    out.push(t);
  }
  state.tokens = out;
}

const headerOf = (t: Token): CalloutHeader => (t.meta as { header: CalloutHeader }).header;

export function calloutPlugin(md: Md): void {
  md.core.ruler.after('block', 'callout', calloutRule);
  const r = md.renderer.rules;
  r.callout_open = (tokens, idx, _opts, _env, self) => openHtml(headerOf(tokens[idx]), self.renderAttrs(tokens[idx])) + '\n';
  r.callout_title_open = (tokens, idx) => titleOpenHtml(headerOf(tokens[idx]));
  r.callout_title_close = (tokens, idx) => titleCloseHtml(headerOf(tokens[idx])) + '\n';
  // No newline after the opening tag: a callout without a body keeps an `:empty` content element.
  r.callout_content_open = () => CONTENT_OPEN;
  r.callout_content_close = () => CONTENT_CLOSE + '\n';
  r.callout_close = (tokens, idx) => closeHtml(headerOf(tokens[idx])) + '\n';
}
