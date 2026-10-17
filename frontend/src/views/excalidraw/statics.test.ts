import { describe, expect, it } from 'vitest';
import { formulaCardSvg, noteCardSvg, placeholderDataUrl, plainInline, previewLines, svgDataUrl, wrapLine } from './statics';

function decode(url: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)));
}

function texts(svg: string): string[] {
  return [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map((t) => t.textContent ?? '');
}

describe('placeholders', () => {
  it('draws placeholders as SVG data URLs, with the text escaped', () => {
    const url = placeholderDataUrl('Missing image', '<script>&"x"</script>');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = decode(url);
    expect(svg).toContain('&lt;script&gt;&amp;&quot;x&quot;&lt;/script&gt;');
    expect(svg).not.toContain('<script>');
  });

  it('encodes any text as UTF-8', () => {
    expect(decode(svgDataUrl('<svg>日本 🎨</svg>'))).toBe('<svg>日本 🎨</svg>');
  });
});

describe('a note as plain text', () => {
  it('shows what a reader sees', () => {
    expect(plainInline('See [[Plans/Q3|the plan]], [[Plans/Q4]], [[Note#Goals]] and [a link](https://x.y) ^block1')).toBe('See the plan, Q4, Note › Goals and a link');
    expect(plainInline('**bold**, *it*, ==mark==, ~~gone~~ and `code`')).toBe('bold, it, mark, gone and code');
    expect(plainInline('<b>raw</b> 2 * 3 * 4')).toBe('raw 2 * 3 * 4');
  });

  it('keeps headings, lists, tasks, quotes and code, and drops frontmatter and comments', () => {
    const md = '---\ntags: [x]\n---\n# Title\n\nIntro %%hidden%% text.\n\n%%\nblock comment\n%%\n- one\n- [ ] todo\n- [x] done\n1. first\n> [!note] Callout\n> quoted\n\n```js\nconst a = 1;\n```\n\n---\n\n\nEnd';
    expect(previewLines(md)).toEqual([
      { text: 'Title', kind: 'heading' },
      { text: '', kind: 'text' },
      { text: 'Intro  text.', kind: 'text' },
      { text: '', kind: 'text' },
      { text: '• one', kind: 'item' },
      { text: '☐ todo', kind: 'item' },
      { text: '☑ done', kind: 'item' },
      { text: '• first', kind: 'item' },
      { text: 'note: Callout', kind: 'quote' },
      { text: 'quoted', kind: 'quote' },
      { text: '', kind: 'text' },
      { text: 'const a = 1;', kind: 'code' },
      { text: '', kind: 'text' },
      { text: 'End', kind: 'text' },
    ]);
  });

  it('wraps at spaces, and breaks words longer than a line', () => {
    expect(wrapLine('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapLine('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLine('', 4)).toEqual(['']);
    expect(wrapLine('日本語のテキスト', 3)).toEqual(['日本語', 'のテキ', 'スト']);
  });
});

describe('static images of the plugin extras', () => {
  it('draws an embedded note as a card of the element’s size, cut to fit', () => {
    const body = Array.from({ length: 40 }, (_, i) => `Line ${i} <b>&</b>`).join('\n');
    const svg = noteCardSvg('Plan › Goals', `# Goals\n${body}`, { width: 300, height: 200 });
    expect(svg).toMatch(/^<svg [^>]*width="300" height="200"/);
    const lines = texts(svg);
    expect(lines[0]).toBe('Plan › Goals');
    expect(lines[1]).toBe('Goals');
    expect(lines.length).toBeLessThan(12);
    expect(lines[lines.length - 1].endsWith('…')).toBe(true);
    expect(lines).toContain('Line 0 &');
    expect(svg).not.toContain('<b>');
  });

  it('shows a LaTeX formula’s source, escaped', () => {
    const svg = formulaCardSvg('\\frac{a<b}{c}', { width: 200, height: 60 });
    expect(texts(svg)).toEqual(['LaTeX', '\\frac{a<b}{c}']);
    expect(svg).toContain('\\frac{a&lt;b}{c}');
    expect(svg).toMatch(/width="200" height="60"/);
  });
});
