// HTML to Markdown with turndown 7.2.4 and its GFM plugin (tables, strikethrough, task lists),
// in the style the app writes: ATX headings, fenced code, `-` bullets, `*` emphasis.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/** Elements that never become Markdown. */
const DROPPED = ['script', 'style', 'noscript', 'template', 'form', 'button', 'input', 'select', 'textarea', 'object', 'embed', 'canvas', 'dialog'];

function attr(node: Node, name: string): string {
  return (node as Element).getAttribute?.(name) ?? '';
}

/** Square brackets would end the alt text or open a wikilink; newlines would end the image. */
function cleanAlt(alt: string): string {
  return alt.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim();
}

/** `(` and `)` and spaces in a URL would end the destination. */
export function markdownUrl(url: string): string {
  return url.replace(/[ ()]/g, (c) => encodeURIComponent(c));
}

export function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.use(gfm);
  td.remove(DROPPED as (keyof HTMLElementTagNameMap)[]);
  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = attr(node, 'src');
      if (!/^https?:\/\//i.test(src)) return '';
      const title = attr(node, 'title').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
      return `![${cleanAlt(attr(node, 'alt'))}](${markdownUrl(src)}${title ? ` "${title}"` : ''})`;
    },
  });
  // A video or other embed becomes a link to it, rather than nothing.
  td.addRule('embed', {
    filter: ['iframe', 'video', 'audio'],
    replacement: (_content, node) => {
      const src = attr(node, 'src') || ((node as Element).querySelector?.('source[src]')?.getAttribute('src') ?? '');
      if (!/^https?:\/\//i.test(src)) return '';
      const label = attr(node, 'title') || (node.nodeName.toLowerCase() === 'iframe' ? 'Embedded content' : node.nodeName.toLowerCase() === 'video' ? 'Video' : 'Audio');
      return `\n\n[${cleanAlt(label)}](${markdownUrl(src)})\n\n`;
    },
  });
  // A link that is not http(s), mailto or a fragment keeps its text only (javascript: and the like).
  td.addRule('unsafeLink', {
    filter: (node) => node.nodeName === 'A' && !!attr(node, 'href') && !/^(https?:|mailto:|#)/i.test(attr(node, 'href')),
    replacement: (content) => content,
  });
  return td;
}

let shared: TurndownService | null = null;

export function toMarkdown(node: Node): string {
  shared ??= createTurndown();
  return shared
    .turndown(node as HTMLElement)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
