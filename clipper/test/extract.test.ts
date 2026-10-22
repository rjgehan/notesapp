import { describe, expect, it } from 'vitest';
import { extractDocument, extractHtml, pageUrl } from '../src/core/extract';
import { selectionHtml } from '../src/core/selection';

const paragraph = (n: number) =>
  `<p>Paragraph ${n} of the article, long enough for Readability to count it as real content, with a few more words, commas, and sentences. It keeps going so the score adds up.</p>`;

const ARTICLE = `<!doctype html><html><head>
<title>The Long Story Of Clipping Web Pages | Example News</title>
<meta name="description" content="What the article is about.">
<meta property="og:site_name" content="Example News">
<meta name="author" content="Grace Hopper">
<meta property="article:published_time" content="2026-09-30T08:00:00Z">
<script>window.evil = 1</script>
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
<h1>The Long Story Of Clipping Web Pages</h1>
${paragraph(1)}
<p>See <a href="/docs/page">the docs</a>, <a href="javascript:alert(1)">this</a> and <a href="#notes">the notes</a>.</p>
<img src="/img/photo.jpg" alt="A [photo]">
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="lazy.png" alt="lazy">
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="pixel">
${paragraph(2)}
<pre><code class="language-js">const x = 1;</code></pre>
<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<p><del>old</del> <em>new</em> <strong>bold</strong></p>
<iframe src="https://www.youtube.com/embed/abc" title="A video"></iframe>
${paragraph(3)}
${paragraph(4)}
</article>
<footer>Copyright</footer>
</body></html>`;

describe('extractHtml', () => {
  const clip = extractHtml(ARTICLE, 'https://news.example.com/2026/story.html#comments');

  it('reads the metadata', () => {
    expect(clip.url).toBe('https://news.example.com/2026/story.html');
    expect(clip.title).toBe('The Long Story Of Clipping Web Pages');
    expect(clip.author).toBe('Grace Hopper');
    expect(clip.siteName).toBe('Example News');
    expect(clip.published).toBe('2026-09-30T08:00:00Z');
    expect(clip.description).toBe('What the article is about.');
    expect(clip.selection).toBe(false);
  });

  it('converts the article, not the page chrome', () => {
    expect(clip.markdown).toContain('Paragraph 1 of the article');
    expect(clip.markdown).toContain('Paragraph 4 of the article');
    expect(clip.markdown).not.toContain('Copyright');
    expect(clip.markdown).not.toContain('About');
    expect(clip.markdown).not.toContain('evil');
  });

  it('makes links and images absolute, and drops unsafe links and inline images', () => {
    expect(clip.markdown).toContain('[the docs](https://news.example.com/docs/page)');
    expect(clip.markdown).toContain(' this ');
    expect(clip.markdown).not.toContain('javascript:');
    expect(clip.markdown).toContain('![A photo](https://news.example.com/img/photo.jpg)');
    expect(clip.markdown).toContain('![lazy](https://news.example.com/2026/lazy.png)');
    expect(clip.markdown).not.toContain('data:');
    expect(clip.images).toEqual(['https://news.example.com/img/photo.jpg', 'https://news.example.com/2026/lazy.png']);
  });

  it('writes GFM: fenced code with its language, tables, strikethrough', () => {
    expect(clip.markdown).toContain('```js\nconst x = 1;\n```');
    expect(clip.markdown).toContain('| A | B |');
    expect(clip.markdown).toMatch(/~+old~+ \*new\* \*\*bold\*\*/);
  });

  it('turns an embed into a link', () => {
    expect(clip.markdown).toContain('[A video](https://www.youtube.com/embed/abc)');
  });

  it('clips only the selection when there is one', () => {
    const sel = extractHtml(ARTICLE, 'https://news.example.com/2026/story.html', { selectionHtml: '<p>Just <b>this</b> and <a href="x">that</a></p>' });
    expect(sel.selection).toBe(true);
    expect(sel.markdown).toBe('Just **this** and [that](https://news.example.com/2026/x)');
    expect(sel.title).toBe('The Long Story Of Clipping Web Pages');
  });

  it('clips a page with little content', () => {
    const c = extractHtml('<html><head><title>Tiny</title></head><body><nav>Menu</nav><p>Short note.</p></body></html>', 'https://e.com/');
    expect(c.title).toBe('Tiny');
    expect(c.markdown).toContain('Short note.');
  });

  it('resolves against the page’s own <base>', () => {
    const html = ARTICLE.replace('<head>', '<head><base href="/static/">');
    const c = extractHtml(html, 'https://news.example.com/2026/story.html');
    expect(c.images).toContain('https://news.example.com/img/photo.jpg');
    expect(c.markdown).toContain('https://news.example.com/static/lazy.png');
  });
});

describe('extractDocument', () => {
  it('leaves the live document as it was', () => {
    document.documentElement.innerHTML = new DOMParser().parseFromString(ARTICLE, 'text/html').documentElement.innerHTML;
    const before = document.documentElement.outerHTML;
    const clip = extractDocument(document, { url: 'https://news.example.com/2026/story.html' });
    expect(clip.markdown).toContain('Paragraph 2');
    expect(document.documentElement.outerHTML).toBe(before);
  });
});

describe('selectionHtml and pageUrl', () => {
  it('serializes the selection, or nothing', () => {
    document.body.innerHTML = '<p id="p">Hello <b>world</b></p>';
    window.getSelection()?.removeAllRanges();
    expect(selectionHtml(window)).toBe('');
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p')!);
    window.getSelection()?.addRange(range);
    expect(selectionHtml(window)).toBe('Hello <b>world</b>');
  });

  it('drops the fragment', () => {
    expect(pageUrl('https://e.com/a#b')).toBe('https://e.com/a');
    expect(pageUrl('not a url')).toBe('not a url');
  });
});
