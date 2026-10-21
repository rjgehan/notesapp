// The markdown-it side of the rich Markdown pack: callouts render directly; math, Mermaid and
// highlighted code render as placeholders that `hydrateRich()` fills after insertion. Placeholders
// keep the rendered HTML independent of which lazy modules are loaded, so the reading view's
// per-block patching (render/patch.ts) keys a block the same way on every render and never
// re-renders an unchanged diagram or formula.
import { tex } from '@mdit/plugin-tex';
import type { MarkdownIt as Md, StateInline } from 'markdown-it';
import { calloutPlugin } from './callouts';
import { escapeHtml } from './html';

export interface RichMarkdownOptions {
  /**
   * Attributes marking an element as app-generated (render.ts's per-render secret). Placeholder
   * attributes (`data-math`, `data-mermaid`, `data-lang`) are reserved: the sanitizer strips them
   * from raw HTML, so only the renderer's own placeholders are hydrated.
   */
  ownAttrs?: () => string;
}

/** `$$…$$` inside a paragraph: display math, as in Obsidian (plugin-tex only takes `$$` blocks). */
function inlineDisplayMath(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x24 || state.src.charCodeAt(start + 1) !== 0x24) return false;
  let close = state.src.indexOf('$$', start + 2);
  // Skip `\$$` (an escaped dollar followed by the closing one is `\$` + `$`).
  while (close > 0 && state.src.charCodeAt(close - 1) === 0x5c) close = state.src.indexOf('$$', close + 1);
  if (close < 0 || close + 2 > state.posMax) return false;
  const content = state.src.slice(start + 2, close);
  if (content.trim() === '') return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = '$$';
    token.content = content;
  }
  state.pos = close + 2;
  return true;
}

export function richMarkdown(md: Md, options: RichMarkdownOptions = {}): void {
  const own = options.ownAttrs ?? (() => '');
  md.use(calloutPlugin);

  // `$…$` and `$$…$$` blocks; the render callback is replaced by the placeholder rules below.
  md.use(tex, { delimiters: 'dollars', render: () => '' });
  md.inline.ruler.before('math_inline_dollar', 'math_inline_display', inlineDisplayMath);
  md.renderer.rules.math_inline = (tokens, idx) => {
    const t = tokens[idx];
    const display = t.markup === '$$';
    return `<span class="math ${display ? 'math-display' : 'math-inline'}"${own()} data-math="${display ? 'display' : 'inline'}">${escapeHtml(t.content)}</span>`;
  };
  md.renderer.rules.math_block = (tokens, idx, _opts, _env, self) =>
    `<div class="math math-block"${own()} data-math="block"${self.renderAttrs(tokens[idx])}>${escapeHtml(tokens[idx].content.replace(/\n$/, ''))}</div>\n`;

  // Fences: Mermaid diagrams, and code with a language (highlighted when hydrated).
  md.renderer.rules.fence = (tokens, idx, _opts, _env, self) => {
    const t = tokens[idx];
    const info = t.info ? md.utils.unescapeAll(t.info).trim() : '';
    const lang = info.split(/\s+/)[0] ?? '';
    const attrs = self.renderAttrs(t);
    if (lang.toLowerCase() === 'mermaid') {
      return `<div class="mermaid-block"${own()} data-mermaid=""${attrs}><pre class="mermaid-source"><code>${escapeHtml(t.content)}</code></pre></div>\n`;
    }
    if (!lang) return `<pre class="code-block"${attrs}><code>${escapeHtml(t.content)}</code></pre>\n`;
    const name = escapeHtml(lang);
    return `<pre class="code-block"${own()} data-lang="${name}"${attrs}><code class="language-${name}">${escapeHtml(t.content)}</code></pre>\n`;
  };
}
