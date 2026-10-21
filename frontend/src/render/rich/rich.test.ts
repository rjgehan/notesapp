import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchChildren } from '../patch';
import { renderNote, renderNoteHtml, toggleTaskAtLine, lineHash, type RenderContext } from '../render';
import { CALLOUT_KINDS, highlightCode, hydrateRich, parseCalloutHeader, renderCallout, renderMath, renderMermaid } from '.';
import { sanitizeMath, sanitizeSvg } from './sanitize';

// Mermaid needs a layout engine (getBBox) that jsdom does not have: the lazy module is replaced by
// a stub that records its calls. Everything else (KaTeX, the grammars) runs for real.
const mermaidCalls: { source: string; theme: string }[] = [];
vi.mock('./mermaid', () => ({
  cachedDiagram: () => null,
  renderDiagram: async (source: string, theme: string) => {
    mermaidCalls.push({ source, theme });
    if (source.includes('bad')) throw new Error('Parse error on line 1: <b>bad</b>');
    const fragment = document.createDocumentFragment();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-theme-used', theme);
    fragment.appendChild(svg);
    return fragment;
  },
}));

const ctx: RenderContext = {
  sourcePath: 'Note.md',
  resolve: () => null,
  rawUrl: () => '',
  strictLineBreaks: false,
  loadRemoteImages: true,
  depth: 0,
};

function dom(text: string): HTMLElement {
  const div = document.createElement('div');
  div.appendChild(renderNote(text, ctx).fragment);
  return div;
}

/** A container in the document (diagrams only render while connected). */
function mounted(text: string): HTMLElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  patchChildren(div, renderNote(text, ctx).fragment);
  return div;
}

beforeEach(() => {
  mermaidCalls.length = 0;
  document.documentElement.setAttribute('data-theme', 'dark');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('callouts: parseCalloutHeader', () => {
  it.each([
    ['[!note]', { type: 'note', kind: 'note', fold: null, title: null, metadata: null }],
    ['[!FAQ]- Why not?', { type: 'faq', kind: 'question', fold: '-', title: 'Why not?', metadata: null }],
    ['[!tip]+', { type: 'tip', kind: 'tip', fold: '+', title: null, metadata: null }],
    ['[!my-type|wide] Custom  ', { type: 'my-type', kind: 'note', fold: null, title: 'Custom', metadata: 'wide' }],
  ])('%s', (line, expected) => {
    expect(parseCalloutHeader(line)).toEqual(expected);
  });

  it.each(['[note]', '[!]', 'text [!note]', '[!note]Title', '[!two words]'])('%s is not a callout', (line) => {
    expect(parseCalloutHeader(line)).toBeNull();
  });

  it('knows every Obsidian type and alias', () => {
    expect(Object.keys(CALLOUT_KINDS).sort()).toEqual(
      ['abstract', 'attention', 'bug', 'caution', 'check', 'cite', 'danger', 'done', 'error', 'example', 'fail', 'failure', 'faq', 'help', 'hint', 'important', 'info', 'missing', 'note', 'question', 'quote', 'success', 'summary', 'tip', 'tldr', 'todo', 'warning'].sort(),
    );
  });
});

describe('callouts: rendering', () => {
  it('renders a callout with the default title, icon and body', () => {
    const el = dom('> [!warning]\n> Careful **now**.');
    const callout = el.querySelector('div.callout')!;
    expect(callout.getAttribute('data-callout')).toBe('warning');
    expect(callout.getAttribute('data-line')).toBe('0');
    expect(callout.querySelector('.callout-title-inner')!.textContent).toBe('Warning');
    expect(callout.querySelector('.callout-icon')).not.toBeNull();
    expect(callout.querySelector('.callout-content p')!.innerHTML).toBe('Careful <strong>now</strong>.');
    expect(callout.querySelector('.callout-content p')!.getAttribute('data-line')).toBe('1');
    expect(el.querySelector('blockquote')).toBeNull();
  });

  it('renders a custom Markdown title and folds with + and -', () => {
    const el = dom('> [!faq]- Why *this*?\n> Because.\n\n> [!example]+ Open\n> Shown.');
    const [closed, open] = [...el.querySelectorAll('details.callout')] as HTMLDetailsElement[];
    expect(closed.open).toBe(false);
    expect(closed.querySelector('summary.callout-title .callout-title-inner')!.innerHTML).toBe('Why <em>this</em>?');
    expect(closed.querySelector('.callout-fold')).not.toBeNull();
    expect(open.open).toBe(true);
    expect(open.getAttribute('data-callout-fold')).toBe('+');
  });

  it('nests callouts and keeps a plain quote a blockquote', () => {
    const el = dom('> [!note] Outer\n> text\n>\n> > [!bug] Inner\n> > deep\n\n> Just a quote');
    const outer = el.querySelector(':scope > .callout')!;
    const inner = outer.querySelector('.callout-content > .callout')!;
    expect(inner.getAttribute('data-callout')).toBe('bug');
    expect(inner.querySelector('.callout-content')!.textContent!.trim()).toBe('deep');
    expect(el.querySelector(':scope > blockquote')!.textContent!.trim()).toBe('Just a quote');
  });

  it('keeps unknown types and metadata, styled as a note', () => {
    const callout = dom('> [!recipe|left] Pancakes').querySelector('.callout')!;
    expect(callout.getAttribute('data-callout')).toBe('recipe');
    expect(callout.getAttribute('data-callout-metadata')).toBe('left');
    expect(callout.querySelector('.callout-title-inner')!.textContent).toBe('Pancakes');
    expect(callout.querySelector('.callout-content')!.childNodes).toHaveLength(0);
  });

  it('keeps tasks inside callouts toggleable', () => {
    const text = '> [!todo]\n> - [ ] inside';
    const box = dom(text).querySelector<HTMLInputElement>('.callout input.task-list-item-checkbox')!;
    expect(box.getAttribute('data-line')).toBe('1');
    const change = toggleTaskAtLine(text, 1, lineHash('> - [ ] inside'))!;
    expect(text.slice(0, change.from) + change.insert + text.slice(change.to)).toBe('> [!todo]\n> - [x] inside');
    expect(box.getAttribute('data-hash')).toBe(lineHash('> - [ ] inside'));
  });

  it('sanitizes HTML in titles and bodies', () => {
    const html = renderNoteHtml('> [!note] <img src=x onerror="alert(1)"> **t**\n> <script>alert(2)</script><a href="javascript:alert(3)">x</a>', ctx);
    expect(html).not.toMatch(/onerror|<script|javascript:/);
    expect(html).toContain('<strong>t</strong>');
  });

  it('renderCallout builds the same markup for other callers', () => {
    const body = document.createElement('p');
    body.textContent = 'Body';
    const el = renderCallout(parseCalloutHeader('[!tip]- Hint')!, 'Custom', body);
    expect(el.tagName).toBe('DETAILS');
    expect(el.getAttribute('data-callout')).toBe('tip');
    expect(el.querySelector('summary .callout-title-inner')!.textContent).toBe('Custom');
    expect(el.querySelector('.callout-content > p')).toBe(body);
    expect(renderCallout(parseCalloutHeader('[!info]')!).querySelector('.callout-title-inner')!.textContent).toBe('Info');
  });
});

describe('math', () => {
  it('renders $inline$, inline $$display$$ and $$ blocks as placeholders', () => {
    const el = dom('Euler $e^{i\\pi}+1=0$ and $$\\sum_i x_i$$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$');
    const [inline, display] = [...el.querySelectorAll('p [data-math]')];
    expect(inline.getAttribute('data-math')).toBe('inline');
    expect(inline.textContent).toBe('e^{i\\pi}+1=0');
    expect(display.getAttribute('data-math')).toBe('display');
    const block = el.querySelector('div[data-math="block"]')!;
    expect(block.textContent).toBe('\\int_0^1 x\\,dx');
    expect(block.getAttribute('data-line')).toBe('2');
  });

  it.each([
    ['Costs $5 and $10 today.', 0],
    ['Escaped \\$x$ stays.', 0],
    ['A $ lone dollar', 0],
    ['$x$, $y$', 2],
    ['`$code$`', 0],
  ])('%s', (text, count) => {
    expect(dom(text).querySelectorAll('[data-math]')).toHaveLength(count);
  });

  it('keeps wikilinks, tags and emphasis inside math as TeX', () => {
    const el = dom('$a_1 * b_2 * [[x]] #tag$');
    expect(el.querySelector('[data-math]')!.textContent).toBe('a_1 * b_2 * [[x]] #tag');
    expect(el.querySelector('a, em')).toBeNull();
  });

  it('escapes TeX as text in the placeholder', () => {
    const el = dom('$a<b>c$');
    expect(el.querySelector('[data-math]')!.textContent).toBe('a<b>c');
    expect(el.querySelector('b')).toBeNull();
  });

  it('hydrates with KaTeX (HTML and MathML)', async () => {
    const el = mounted('Inline $x^2$.\n\n$$\n\\frac{a}{b}\n$$');
    hydrateRich(el);
    await vi.waitFor(() => expect(el.querySelectorAll('.math.is-rendered')).toHaveLength(2));
    expect(el.querySelector('.math-inline .katex .katex-html')).not.toBeNull();
    expect(el.querySelector('.math-inline math annotation')!.textContent).toBe('x^2');
    expect(el.querySelector('.math-block .katex-display')).not.toBeNull();
  });

  it('keeps trust off: no links, images, classes or styles from TeX', async () => {
    const el = document.createElement('div');
    await renderMath(el, '\\href{javascript:alert(1)}{x} \\url{https://e.com} \\includegraphics{https://e.com/a.png} \\htmlClass{evil}{y} \\htmlStyle{position:fixed}{z}', false);
    // The commands render as error text (the TeX source survives only as the MathML annotation's text).
    expect(el.querySelector('a, img, [href], [src], .evil')).toBeNull();
    expect([...el.querySelectorAll('[style]')].map((s) => s.getAttribute('style')).join(';')).not.toMatch(/position/);
    expect(el.querySelector('.katex-html')!.textContent).toBe('\\href\\url\\includegraphics\\htmlClass\\htmlStyle');
  });

  it('shows a TeX error inline', async () => {
    const el = document.createElement('div');
    await renderMath(el, '\\frac{', false);
    expect(el.querySelector('.katex-error')!.textContent).toContain('\\frac{');
  });
});

describe('code', () => {
  it('renders fences as escaped code with the language', () => {
    const pre = dom('```TypeScript\nconst x = "<script>";\n```').querySelector('pre')!;
    expect(pre.getAttribute('data-lang')).toBe('TypeScript');
    expect(pre.getAttribute('data-line')).toBe('0');
    expect(pre.querySelector('code')!.className).toBe('language-TypeScript');
    expect(pre.querySelector('code')!.textContent).toBe('const x = "<script>";\n');
    expect(pre.querySelector('script')).toBeNull();
  });

  it('highlights with the editor grammars and token classes', async () => {
    const fragment = (await highlightCode('const x = 1; // hi\n', 'ts'))!;
    const holder = document.createElement('code');
    holder.appendChild(fragment);
    expect(holder.textContent).toBe('const x = 1; // hi\n');
    expect(holder.querySelector('.cm-tok-keyword')!.textContent).toBe('const');
    expect(holder.querySelector('.cm-tok-number')!.textContent).toBe('1');
    expect(holder.querySelector('.cm-tok-comment')!.textContent).toBe('// hi');
    expect(await highlightCode('x', 'no-such-language')).toBeNull();
  });

  it('hydrates code blocks: highlighting and a copy button, never HTML from the code', async () => {
    const el = mounted('```py\nprint("<img src=x onerror=alert(1)>")\n```\n\n```nope\nplain\n```\n\n```\nno language\n```');
    hydrateRich(el);
    const [py, unknown, plain] = [...el.querySelectorAll('pre')];
    await vi.waitFor(() => expect(py.classList.contains('is-highlighted')).toBe(true));
    expect(py.querySelector('code .cm-tok-string')).not.toBeNull();
    expect(py.querySelector('img')).toBeNull();
    expect(py.querySelector('code')!.textContent).toBe('print("<img src=x onerror=alert(1)>")\n');
    expect(unknown.classList.contains('is-highlighted')).toBe(false);
    expect([py, unknown, plain].map((p) => p.querySelectorAll('button.code-copy').length)).toEqual([1, 1, 1]);
  });
});

describe('mermaid', () => {
  it('renders fences as placeholders keeping the source', () => {
    const block = dom('```mermaid\ngraph TD\nA-->B\n```').querySelector('.mermaid-block')!;
    expect(block.hasAttribute('data-mermaid')).toBe(true);
    expect(block.getAttribute('data-line')).toBe('0');
    expect(block.querySelector('.mermaid-source')!.textContent).toBe('graph TD\nA-->B\n');
  });

  it('hydrates into an SVG, shows errors as text, and follows the theme', async () => {
    const el = mounted('```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\nbad <b>\n```');
    hydrateRich(el);
    const [good, bad] = [...el.querySelectorAll<HTMLElement>('.mermaid-block')];
    await vi.waitFor(() => expect(good.classList.contains('is-rendered')).toBe(true));
    await vi.waitFor(() => expect(bad.classList.contains('has-error')).toBe(true));
    expect(good.querySelector('.mermaid-svg svg')!.getAttribute('data-theme-used')).toBe('dark');
    const error = bad.querySelector('.mermaid-error')!;
    expect(error.textContent).toContain('Parse error on line 1: <b>bad</b>');
    expect(error.querySelector('b')).toBeNull();

    document.documentElement.setAttribute('data-theme', 'light');
    await vi.waitFor(() => expect(good.querySelector('.mermaid-svg svg')!.getAttribute('data-theme-used')).toBe('light'));
    expect(mermaidCalls.filter((c) => c.theme === 'light')).toHaveLength(2);
  });

  it('renderMermaid renders into any element', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    await renderMermaid(target, 'graph LR\nX-->Y');
    expect(target.classList.contains('mermaid-block')).toBe(true);
    expect(target.querySelector('.mermaid-svg svg')).not.toBeNull();
  });
});

describe('placeholders and patching', () => {
  it('raw HTML cannot forge placeholders', () => {
    const el = dom('<span data-math="inline">x</span>\n\n<div data-mermaid="">graph TD</div>\n\n<pre data-lang="js"><code>x</code></pre>');
    expect(el.querySelector('[data-math], [data-mermaid], [data-lang]')).toBeNull();
  });

  it('never re-renders math or diagrams in blocks an edit did not touch', async () => {
    const before = 'Intro\n\n$$\nE = mc^2\n$$\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```ts\nlet a = 1;\n```';
    const el = mounted(before);
    hydrateRich(el);
    await vi.waitFor(() => expect(el.querySelectorAll('.is-rendered, .is-highlighted')).toHaveLength(3));
    const katexNode = el.querySelector('.katex');
    const svg = el.querySelector('.mermaid-svg svg');
    const code = el.querySelector('pre.code-block code span');
    expect(mermaidCalls).toHaveLength(1);

    const stats = patchChildren(el, renderNote(before.replace('Intro', 'Intro, edited'), ctx).fragment);
    hydrateRich(el);
    expect(stats).toEqual({ kept: 3, inserted: 1, removed: 1 });
    expect(el.querySelector('.katex')).toBe(katexNode);
    expect(el.querySelector('.mermaid-svg svg')).toBe(svg);
    expect(el.querySelector('pre.code-block code span')).toBe(code);
    await new Promise((r) => setTimeout(r, 10));
    expect(mermaidCalls).toHaveLength(1);

    // An edit inside the diagram re-renders that diagram only; changed code re-highlights at once.
    patchChildren(el, renderNote(before.replace('A-->B', 'A-->C').replace('let a', 'let b'), ctx).fragment);
    hydrateRich(el);
    expect(el.querySelector('pre.code-block')!.classList.contains('is-highlighted')).toBe(true);
    await vi.waitFor(() => expect(mermaidCalls).toHaveLength(2));
    expect(mermaidCalls[1].source).toBe('graph TD\nA-->C\n');
    expect(el.querySelector('.katex')).toBe(katexNode);
  });
});

describe('sanitizers', () => {
  it('sanitizeMath keeps KaTeX markup and drops anything active', () => {
    const holder = document.createElement('div');
    holder.appendChild(
      sanitizeMath(
        '<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math></span>' +
          '<span class="katex-html" style="position:fixed;z-index:9;height:1em"><svg width="1" height="1"><path d="M0 0"></path></svg></span></span>' +
          '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">a</a><span onclick="alert(1)">c</span><style>*{}</style>',
      ),
    );
    expect(holder.querySelector('math semantics annotation')!.getAttribute('encoding')).toBe('application/x-tex');
    expect(holder.querySelector('svg path')).not.toBeNull();
    expect(holder.querySelector('.katex-html')!.getAttribute('style')).toBe('height:1em');
    expect(holder.innerHTML).not.toMatch(/<script|<img|<a |onclick|<style|javascript:/);
  });

  it('sanitizeSvg keeps Mermaid markup and drops scripts, handlers and remote references', () => {
    const holder = document.createElement('div');
    holder.appendChild(
      sanitizeSvg(
        '<svg id="m1" xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><style>#m1 .node{fill:red;background:url(https://evil.example/x.png)}@import url(https://evil.example/a.css);</style>' +
          '<script>alert(2)</script><g class="node"><rect style="fill:url(#grad);position:fixed"></rect><text>Label</text></g>' +
          '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">HTML label</span><iframe src="https://evil.example"></iframe></div></foreignObject>' +
          '<image href="https://evil.example/t.png"></image><a href="javascript:alert(3)"><text>link</text></a></svg>',
      ),
    );
    const svg = holder.querySelector('svg')!;
    expect(svg.hasAttribute('onload')).toBe(false);
    expect(holder.querySelector('script, iframe, a')).toBeNull();
    const style = holder.querySelector('style')!.textContent!;
    expect(style).toContain('#m1 .node{fill:red;');
    expect(style).not.toMatch(/evil|@import/);
    expect(holder.querySelector('rect')!.getAttribute('style')).toBe('fill:url(#grad)');
    expect(holder.querySelector('foreignObject .nodeLabel')!.textContent).toBe('HTML label');
    expect(holder.querySelector('image')!.hasAttribute('href')).toBe(false);
    expect(holder.textContent).toContain('link');
  });
});
