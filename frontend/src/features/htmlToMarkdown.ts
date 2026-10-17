// Rich paste (DESIGN §6.6.1, ROADMAP 10a): HTML from a web page, Google Docs or Word becomes
// Markdown, with turndown and its GFM plugin (tables, strikethrough, task lists). A lazy chunk: the
// editor loads it the first time it gets the focus. The HTML is sanitized first and parsed into an
// inert document, so nothing in it runs or loads; then the quirks of the usual sources are smoothed
// out (Google Docs' bold wrapper and styled spans, Word's list paragraphs, tables without a header
// row) before turndown writes the Markdown.
import { gfm } from '@joplin/turndown-plugin-gfm';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { encodeMdPath } from './links';

export interface HtmlToMarkdownOptions {
  /** `[[links]]` for links copied from this app's reading view (else Markdown links). */
  useWikilinks: boolean;
  /** Line breaks need two trailing spaces (`settings.editor.strictLineBreaks`). */
  strictLineBreaks: boolean;
}

/** Tags whose content is never note text. */
const FORBID_TAGS = ['style', 'script', 'noscript', 'template', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'audio', 'video', 'title', 'meta', 'link'];

let purifier: ReturnType<typeof DOMPurify> | null = null;

function purify(): ReturnType<typeof DOMPurify> {
  purifier ??= DOMPurify(window);
  return purifier;
}

/** Sanitized HTML as an inert document: no script runs, no image loads. */
function parse(html: string): Document {
  const clean = purify().sanitize(html, { FORBID_TAGS, ALLOW_DATA_ATTR: true });
  return new DOMParser().parseFromString(`<!doctype html><body>${clean}</body>`, 'text/html');
}

// ---------- cleaning up the usual sources ----------

function styleOf(el: Element): string {
  return (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
}

function unwrap(el: Element): void {
  el.replaceWith(...el.childNodes);
}

function wrapContents(el: Element, tag: string): void {
  const wrapper = el.ownerDocument.createElement(tag);
  wrapper.append(...el.childNodes);
  el.appendChild(wrapper);
}

const MONOSPACE = /courier|consolas|monaco|menlo|monospace|sourcecode|robotomono|firacode|jetbrains|inconsolata/;

/**
 * Google Docs and Word mark bold, italic, strikethrough and code fonts with styles on `<span>`s, and
 * Google Docs wraps the whole clipboard in `<b style="font-weight:normal" id="docs-internal-guid-…">`.
 */
function styledSpans(doc: Document): void {
  for (const b of doc.body.querySelectorAll('b, strong')) {
    if (/font-weight:(normal|[1-4]00)/.test(styleOf(b)) || b.id.startsWith('docs-internal-guid')) unwrap(b);
  }
  for (const span of doc.body.querySelectorAll('span, font')) {
    const style = styleOf(span);
    if (!style && !span.getAttribute('face')) continue;
    const inHeading = span.closest('h1, h2, h3, h4, h5, h6, th') !== null;
    // The last declaration wins, as in CSS.
    const family = [...style.matchAll(/font-family:([^;]+)/g)].at(-1)?.[1] ?? span.getAttribute('face')?.toLowerCase().replace(/\s+/g, '') ?? '';
    if (MONOSPACE.test(family) && span.closest('pre, code') === null && span.textContent?.trim()) wrapContents(span, 'code');
    if (/text-decoration[^;]*line-through/.test(style)) wrapContents(span, 'del');
    if (/font-style:italic/.test(style)) wrapContents(span, 'em');
    if (!inHeading && /font-weight:(bold|bolder|[6-9]00)/.test(style)) wrapContents(span, 'strong');
  }
}

/** Google Docs checklists: `<li role="checkbox" aria-checked>` items with a picture of a box. */
function checklistItems(doc: Document): void {
  for (const li of doc.body.querySelectorAll('li[role="checkbox"]')) {
    for (const img of li.querySelectorAll('img')) img.remove();
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = li.getAttribute('aria-checked') === 'true';
    li.prepend(box);
    li.removeAttribute('role');
  }
}

/** A list item's only paragraph (Google Docs writes one in every item) is its text, so the list stays tight. */
function itemParagraphs(doc: Document): void {
  for (const li of doc.body.querySelectorAll('li')) {
    const paragraphs = [...li.children].filter((c) => c.tagName === 'P');
    if (paragraphs.length === 1) unwrap(paragraphs[0]);
  }
}

/** Rebuilds `items` (each with its level, 1 = top) as nested lists under `anchor`'s place. */
function nestItems(doc: Document, anchor: Element, items: Array<{ li: Element; level: number; ordered: boolean }>): void {
  const stack: Array<{ level: number; list: Element }> = [];
  const root = doc.createElement(items[0].ordered ? 'ol' : 'ul');
  anchor.before(root);
  stack.push({ level: items[0].level, list: root });
  for (const item of items) {
    let top = stack[stack.length - 1];
    while (stack.length > 1 && item.level < top.level) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (item.level > top.level && top.list.lastElementChild) {
      const nested = doc.createElement(item.ordered ? 'ol' : 'ul');
      top.list.lastElementChild.appendChild(nested);
      stack.push({ level: item.level, list: nested });
      top = stack[stack.length - 1];
    }
    top.list.appendChild(item.li);
  }
}

/** Siblings that follow each other, ignoring blank text between them. */
function runsOf(elements: readonly Element[]): Element[][] {
  const runs: Element[][] = [];
  for (const el of elements) {
    const last = runs.at(-1);
    let prev = el.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()) prev = prev.previousSibling;
    if (last && prev === last[last.length - 1]) last.push(el);
    else runs.push([el]);
  }
  return runs;
}

/** Word writes list items as paragraphs (`mso-list: l0 level2`) with the bullet or number as text. */
function wordLists(doc: Document): void {
  const paragraphs = [...doc.body.querySelectorAll('p')].filter((p) => /mso-list:l\d+level\d+/.test(styleOf(p)) || /MsoListParagraph/i.test(p.className));
  // Each list has its id (`l0`, `l1`): two lists next to each other stay two lists.
  const listId = (p: Element) => /mso-list:(l\d+)/.exec(styleOf(p))?.[1] ?? '';
  const runs: Element[][] = [];
  for (const run of runsOf(paragraphs)) {
    let current: Element[] = [];
    for (const p of run) {
      if (current.length > 0 && listId(current[0]) !== listId(p)) {
        runs.push(current);
        current = [];
      }
      current.push(p);
    }
    runs.push(current);
  }
  for (const run of runs) {
    const items = run.map((p) => {
      const level = Number(/level(\d+)/.exec(styleOf(p))?.[1] ?? '1');
      const marker = [...p.querySelectorAll('span')].find((s) => /mso-list:ignore/.test(styleOf(s)));
      const text = marker?.textContent?.replace(/\s+/g, '') ?? '';
      marker?.remove();
      const li = doc.createElement('li');
      li.append(...p.childNodes);
      return { li, level, ordered: /^\(?[0-9a-zA-Z]{1,4}[.)]$/.test(text) && !/^[o§·•▪-]$/.test(text), p };
    });
    nestItems(
      doc,
      run[0],
      items.map(({ li, level, ordered }) => ({ li, level, ordered })),
    );
    for (const item of items) item.p.remove();
  }
}

/** Google Docs writes nested items as one flat list whose items carry `aria-level`. */
function leveledLists(doc: Document): void {
  const lists = [...doc.body.querySelectorAll('ul, ol')].filter((l) => l.parentElement?.closest('ul, ol') === null && [...l.children].some((li) => Number(li.getAttribute('aria-level') ?? '1') > 1));
  for (const run of runsOf(lists)) {
    const items = run.flatMap((list) => [...list.children].filter((c) => c.tagName === 'LI').map((li) => ({ li, level: Number(li.getAttribute('aria-level') ?? '1'), ordered: list.tagName === 'OL' })));
    if (items.length === 0) continue;
    nestItems(doc, run[0], items);
    for (const list of run) list.remove();
  }
}

/**
 * Images that would put a huge `data:` URI or a path on someone's disk into the note (Word's
 * `file:///…/clip_image001.png`) are dropped; their alt text stays.
 */
function localImages(doc: Document): void {
  for (const img of doc.body.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (/^\s*(?:https?:)?\/\//i.test(src)) continue;
    const alt = img.getAttribute('alt')?.trim();
    img.replaceWith(alt ? doc.createTextNode(alt) : '');
  }
}

/**
 * GFM tables need a header row and one line per row: a table without `<th>` gets its first row as
 * the header (Google Docs, Word and spreadsheets write none), the header gets as many cells as the
 * widest row, and blocks inside cells (paragraphs, lists, headings, code) become lines of text,
 * which the cell writes with `<br>`.
 */
function tables(doc: Document): void {
  for (const table of [...doc.body.querySelectorAll('table')]) {
    // A table of tables is layout: the GFM plugin writes its cells as paragraphs.
    if (table.querySelector('table')) continue;
    const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH'));
    if (rows.length === 0) continue;
    const span = (cell: Element) => Math.max(1, Math.min(50, Number(cell.getAttribute('colspan') ?? '1') || 1));
    const columns = Math.max(...rows.map((cells) => cells.reduce((n, c) => n + span(c), 0)));
    // Rebuilt plainly: the header row in a `<thead>`, every row with all its cells and nothing between them.
    const head = doc.createElement('thead');
    const body = doc.createElement('tbody');
    rows.forEach((cells, i) => {
      const tag = i === 0 ? 'th' : 'td';
      const tr = doc.createElement('tr');
      for (const source of cells) {
        const cell = doc.createElement(tag);
        cell.append(...source.childNodes);
        const align = source.getAttribute('align') ?? /text-align:(left|center|right)/.exec(styleOf(source))?.[1];
        if (align) cell.setAttribute('align', align);
        tr.appendChild(cell);
        for (let n = 1; n < span(source); n++) tr.appendChild(doc.createElement(tag));
      }
      while (tr.children.length < columns) tr.appendChild(doc.createElement(tag));
      (i === 0 ? head : body).appendChild(tr);
    });
    const plain = doc.createElement('table');
    plain.appendChild(head);
    if (body.children.length > 0) plain.appendChild(body);
    const caption = table.querySelector('caption');
    if (caption?.textContent?.trim()) {
      const p = doc.createElement('p');
      p.append(...caption.childNodes);
      table.before(p);
    }
    table.replaceWith(plain);
    // Blocks inside a cell become lines of text, which the cell writes with `<br>`.
    for (const cell of plain.querySelectorAll('td, th')) {
      for (const list of [...cell.querySelectorAll('ul, ol')].reverse()) {
        const lines = [...list.children].map((li) => li.textContent?.trim() ?? '').filter(Boolean);
        list.replaceWith(...lines.flatMap((line, i) => (i === 0 ? [line] : [doc.createElement('br'), line])));
      }
      for (const pre of cell.querySelectorAll('pre')) {
        const code = doc.createElement('code');
        code.textContent = pre.textContent?.replace(/\s*\n\s*/g, ' ') ?? '';
        pre.replaceWith(code);
      }
      for (const hr of cell.querySelectorAll('hr')) hr.remove();
      for (const block of [...cell.querySelectorAll('h1, h2, h3, h4, h5, h6, blockquote, p, div')].reverse()) {
        if (block.nextSibling) block.after(doc.createElement('br'));
        unwrap(block);
      }
    }
  }
}

/** Non-breaking spaces (Google Docs is full of them) become spaces, so Markdown sees them as spaces. */
function plainSpaces(doc: Document): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.includes('\u00a0')) node.nodeValue = node.nodeValue.replace(/\u00a0/g, ' ');
  }
}

// ---------- turndown ----------

/**
 * Backslashes only where text would otherwise read as Markdown. turndown's own escaping also
 * escapes every `_`, `*` and `[`, which would show as backslashes in Live Preview (escapes stay
 * visible there, DESIGN §6.6.1).
 */
export function escapeMarkdown(text: string): string {
  // Outside the text counts as a space.
  const at = (i: number) => text[i] ?? ' ';
  const space = (ch: string) => /\s/.test(ch);
  const word = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let escape: boolean;
    switch (ch) {
      case '\\':
        // A backslash that would escape the character after it.
        escape = /[!-/:-@[-`{-~]/.test(at(i + 1));
        break;
      case '`':
        escape = true;
        break;
      case '*':
        // Emphasis: an asterisk next to text (`5 * 3` stays as it is).
        escape = !space(at(i - 1)) || !space(at(i + 1));
        break;
      case '_':
        // An underscore inside a word never makes emphasis (`snake_case` stays as it is).
        escape = (!word(at(i - 1)) && !space(at(i + 1))) || (!space(at(i - 1)) && !word(at(i + 1)));
        break;
      case '~':
        escape = at(i - 1) === '~' || at(i + 1) === '~';
        break;
      case '=':
        // `==highlight==`
        escape = (at(i + 1) === '=' && !space(at(i + 2))) || (at(i - 1) === '=' && !space(at(i - 2)));
        break;
      case '%':
        // `%%comment%%`
        escape = at(i + 1) === '%';
        break;
      case '[':
        // `[[link]]`, `[^footnote]`
        escape = at(i + 1) === '[' || at(i + 1) === '^';
        break;
      case ']':
        // `[text](url)`, `[ref]: url`, `[text][ref]`
        escape = at(i + 1) === '(' || at(i + 1) === ':' || at(i + 1) === '[';
        break;
      case '!':
        escape = at(i + 1) === '[';
        break;
      case '<':
        // HTML and `<url>`; `a < b` stays as it is.
        escape = /[a-zA-Z/!?]/.test(at(i + 1));
        break;
      case '&':
        escape = /^&#?\w+;/.test(text.slice(i, i + 12));
        break;
      default:
        escape = false;
    }
    out += escape ? '\\' + ch : ch;
  }
  // Block markup at the start of the text: headings, list markers, quotes, table rows, setext underlines.
  return out
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^([-+*])(?=\s)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2')
    .replace(/^>/, '\\>')
    .replace(/^\|/, '\\|')
    .replace(/^(=+|-+)(?=\s*$)/, '\\$1');
}

function turndownFor(options: HtmlToMarkdownOptions): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: options.strictLineBreaks ? '  ' : '',
  });
  service.use(gfm);
  service.escape = escapeMarkdown;
  service.addRule('listItem', {
    filter: 'li',
    replacement(content, node) {
      const parent = node.parentNode as Element | null;
      let marker = '- ';
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? '1');
        marker = `${(Number.isFinite(start) ? start : 1) + [...parent.children].indexOf(node as Element)}. `;
      }
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        // One space after a task box (the checkbox and the text after it each bring one).
        .replace(/^(\[[ x]\])[ \t]+/, '$1 ')
        .replace(/\n(?=.)/g, '\n' + ' '.repeat(marker.length));
      return marker + body + (node.nextSibling && !body.endsWith('\n') ? '\n' : '');
    },
  });
  service.addRule('highlight', {
    filter: 'mark',
    replacement: (content) => (content.trim() ? `==${content}==` : content),
  });
  // Links copied from this app's reading view: back to the note links they were.
  service.addRule('internalLink', {
    filter: (node) => node.nodeName === 'A' && node.classList.contains('internal-link') && node.hasAttribute('data-href'),
    replacement(_content, node) {
      const target = (node as Element).getAttribute('data-href') ?? '';
      const text = (node.textContent ?? '').trim();
      const shown = target.replace(/^#/, '').replace(/#/g, ' > ');
      if (options.useWikilinks) return text === '' || text === shown || text === target ? `[[${target}]]` : `[[${target}|${text}]]`;
      const hash = target.indexOf('#');
      const path = hash < 0 ? target : target.slice(0, hash);
      const subpath = hash < 0 ? '' : '#' + encodeMdPath(target.slice(hash + 1));
      return `[${text || shown}](${encodeMdPath(path)}${subpath})`;
    },
  });
  service.addRule('tagLink', {
    filter: (node) => node.nodeName === 'A' && node.classList.contains('tag'),
    replacement: (_content, node) => node.textContent ?? '',
  });
  // Underlines, superscripts and the like keep their text; Markdown has no form for them.
  service.addRule('plainInline', {
    filter: ['u', 'ins', 'sup', 'sub', 'small', 'abbr', 'cite', 'q', 'kbd', 'var', 'samp'],
    replacement: (content) => content,
  });
  return service;
}

/** Collapses the blank lines turndown leaves between blocks, and trims. */
function tidy(markdown: string, strictLineBreaks: boolean): string {
  return markdown
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : strictLineBreaks ? line : line.trimEnd()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Markdown for pasted HTML (DESIGN §6.6.1). */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions): string {
  const doc = parse(html);
  styledSpans(doc);
  checklistItems(doc);
  itemParagraphs(doc);
  wordLists(doc);
  leveledLists(doc);
  localImages(doc);
  tables(doc);
  plainSpaces(doc);
  return tidy(turndownFor(options).turndown(doc.body), options.strictLineBreaks);
}
