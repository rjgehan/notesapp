import { describe, expect, it } from 'vitest';
import { escapeMarkdown, htmlToMarkdown } from './htmlToMarkdown';

const options = { useWikilinks: true, strictLineBreaks: false };
const md = (html: string, o: Partial<typeof options> = {}) => htmlToMarkdown(html, { ...options, ...o });

describe('rich paste: HTML to Markdown (ROADMAP 10a)', () => {
  it('converts a web page: headings, emphasis, links, lists, quotes, code, rules and images', () => {
    const html =
      '<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> and <a href="https://example.com">a link</a>.</p>' +
      '<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><ol start="3"><li>Three</li><li>Four</li></ol>' +
      '<blockquote><p>Quote</p></blockquote><pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>' +
      '<p>Inline <code>code</code> here</p><hr><p><img src="https://example.com/a.png" alt="pic"></p>';
    expect(md(html)).toBe(
      [
        '# Title',
        '',
        'Some **bold** and *italic* and [a link](https://example.com).',
        '',
        '- One',
        '- Two',
        '  - Nested',
        '',
        '3. Three',
        '4. Four',
        '',
        '> Quote',
        '',
        '```js',
        'const a = 1;',
        'const b = 2;',
        '```',
        '',
        'Inline `code` here',
        '',
        '---',
        '',
        '![pic](https://example.com/a.png)',
      ].join('\n'),
    );
  });

  it('converts Google Docs, unwrapping its <b id="docs-internal-guid-…"> wrapper and reading its styled spans', () => {
    const span = (style: string, text: string) => `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;${style}white-space:pre;white-space:pre-wrap;">${text}</span>`;
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-7fff-1234-5678-9abcdef01234">' +
      `<h1 dir="ltr" style="line-height:1.38;margin-top:20pt;"><span style="font-size:20pt;font-weight:700;">Project plan</span></h1>` +
      `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">${span('font-weight:400;font-style:normal;', 'Some ')}${span('font-weight:700;', 'bold')}${span('font-weight:400;', ', ')}${span('font-weight:400;font-style:italic;', 'italic')}${span('font-weight:400;', '&nbsp;and ')}${span('font-weight:400;text-decoration:line-through;', 'struck')}${span('', ', ')}${span('font-family:\'Courier New\',monospace;', 'code')}${span('font-weight:400;', '&nbsp;text.')}</p><br>` +
      '<ul style="margin-top:0;margin-bottom:0;"><li dir="ltr" style="list-style-type:disc;" aria-level="1"><p dir="ltr" role="presentation">' +
      span('font-weight:400;', 'First') +
      '</p></li><li dir="ltr" style="list-style-type:circle;" aria-level="2"><p dir="ltr" role="presentation">' +
      span('font-weight:400;', 'Nested') +
      '</p></li><li dir="ltr" aria-level="1"><p dir="ltr" role="presentation">' +
      span('font-weight:400;', 'Second') +
      '</p></li></ul>' +
      '<ul><li role="checkbox" aria-checked="false" aria-level="1"><img src="data:image/png;base64,AAAA" alt=""><p role="presentation">' +
      span('', 'Todo') +
      '</p></li><li role="checkbox" aria-checked="true" aria-level="1"><img src="data:image/png;base64,AAAA"><p>' +
      span('', 'Done') +
      '</p></li></ul></b><br class="Apple-interchange-newline">';
    expect(md(html)).toBe(['# Project plan', '', 'Some **bold**, *italic* and ~~struck~~, `code` text.', '', '- First', '  - Nested', '- Second', '', '- [ ] Todo', '- [x] Done'].join('\n'));
  });

  it('turns a Google Docs or Word table, which has no header row, into a table with its first row as the header', () => {
    const html =
      '<div dir="ltr" align="left"><table style="border:none;border-collapse:collapse;"><colgroup><col width="100"><col width="100"></colgroup><tbody>' +
      '<tr style="height:0pt"><td style="border-left:solid #000000 1pt;"><p dir="ltr"><span>Name</span></p></td><td><p><span>Age</span></p></td></tr>' +
      '<tr><td><p><span>Ann</span></p></td><td><p><span>31</span></p></td></tr>\n<tr><td>Bob</td></tr></tbody></table></div>';
    expect(md(html)).toBe(['| Name | Age |', '| --- | --- |', '| Ann | 31  |', '| Bob |     |'].join('\n'));
  });

  it('keeps alignment, escapes pipes and writes blocks inside a cell as lines', () => {
    const html = '<table><thead><tr><th align="left">A</th><th align="right">B|C</th></tr></thead><tbody><tr><td>1</td><td><ul><li>x</li><li>y</li></ul></td></tr></tbody></table>';
    expect(md(html)).toBe(['| A   | B\\|C |', '| :--- | ---: |', '| 1   | x<br>y |'].join('\n'));
  });

  it('converts Word list paragraphs into lists, nested by level, one list per list', () => {
    const item = (list: string, level: number, marker: string, text: string) =>
      `<p class=MsoListParagraphCxSpMiddle style='text-indent:-18.0pt;mso-list:${list} level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span><![endif]>${text}<o:p></o:p></p>\n`;
    const html = `<p class=MsoNormal>Intro <b>bold</b><o:p></o:p></p>\n${item('l0', 1, '·', 'Apple')}${item('l0', 2, 'o', 'Green')}${item('l0', 1, '·', 'Banana')}${item('l1', 1, '1.', 'First step')}${item('l1', 1, '2.', 'Second step')}`;
    expect(md(html)).toBe(['Intro **bold**', '', '- Apple', '  - Green', '- Banana', '', '1. First step', '2. Second step'].join('\n'));
  });

  it('converts task lists, strikethrough and highlights', () => {
    const html = '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> todo</li><li class="task-list-item"><input type="checkbox" checked disabled> done</li></ul><p><del>gone</del>, <s>struck</s> and <mark>marked</mark></p>';
    expect(md(html)).toBe(['- [ ] todo', '- [x] done', '', '~~gone~~, ~~struck~~ and ==marked=='].join('\n'));
  });

  it('turns links copied from the reading view back into note links', () => {
    const html = '<p>See <a class="internal-link" data-href="My Note" href="/n/My%20Note.md">My Note</a>, <a class="internal-link" data-href="Other#Part" href="#">the part</a> and <a class="tag" href="#" data-tag="x">#x</a></p>';
    expect(md(html)).toBe('See [[My Note]], [[Other#Part|the part]] and #x');
    expect(md(html, { useWikilinks: false })).toBe('See [My Note](My%20Note), [the part](Other#Part) and #x');
  });

  it('writes line breaks as Obsidian reads them, and as two spaces with strict line breaks', () => {
    expect(md('<p>line one<br>line two</p>')).toBe('line one\nline two');
    expect(md('<p>line one<br>line two</p>', { strictLineBreaks: true })).toBe('line one  \nline two');
  });

  it('sanitizes first: no script, no event handler, no javascript: link, no frame, no style text', () => {
    const out = md('<p>Hi<script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">click</a><style>p{color:red}</style><iframe src="https://evil.example"></iframe></p>');
    expect(out).toBe('Hiclick');
  });

  it('drops images that would put a data: URI or a local path into the note, keeping their alt text', () => {
    expect(md('<p>a <img src="data:image/png;base64,AAAA" alt="chart"> b <img src="file:///C:/Users/x/clip_image001.png"></p>')).toBe('a chart b');
  });

  it('copes with malformed HTML', () => {
    expect(md('<p><b>bold <i>both</b> italic</i><table><tr><td>a<td>b<tr><td>c')).toBe(['**bold *both*** *italic*', '', '| a   | b   |', '| --- | --- |', '| c   |     |'].join('\n'));
    expect(md('<ul><li>one<li>two</ul></ol></p>')).toBe('- one\n- two');
    expect(md('')).toBe('');
  });

  it('turns non-breaking spaces into spaces and leaves no blank runs', () => {
    expect(md('<p>a&nbsp;b&nbsp;&nbsp;</p><br><br><p>c</p>')).toBe('a b\n\nc');
  });
});

describe('escaping pasted text (ROADMAP 10a)', () => {
  it('leaves ordinary text alone', () => {
    for (const text of ['snake_case', '5 * 3', 'a == b', 'a < b', 'it’s 100% done', 'Q&A', 'see [1] and (2)', 'x ~ y']) expect(escapeMarkdown(text)).toBe(text);
  });

  it('escapes what would read as Markdown', () => {
    expect(escapeMarkdown('*stars* and _under_')).toBe('\\*stars\\* and \\_under\\_');
    expect(escapeMarkdown('[[not a link]] and [text](url) and ![x]')).toBe('\\[[not a link]] and [text\\](url) and \\![x]');
    expect(escapeMarkdown('==mark== ~~strike~~ %%c%%')).toBe('\\==mark=\\= \\~\\~strike\\~\\~ \\%%c\\%%');
    expect(escapeMarkdown('`code` and <b> and &amp;')).toBe('\\`code\\` and \\<b> and \\&amp;');
    expect(escapeMarkdown('a\\*b')).toBe('a\\\\\\*b');
  });

  it('escapes block markup at the start', () => {
    expect(escapeMarkdown('# not heading')).toBe('\\# not heading');
    expect(escapeMarkdown('- not a bullet')).toBe('\\- not a bullet');
    expect(escapeMarkdown('* not a bullet')).toBe('\\* not a bullet');
    expect(escapeMarkdown('1. not a list')).toBe('1\\. not a list');
    expect(escapeMarkdown('> not a quote')).toBe('\\> not a quote');
    expect(escapeMarkdown('| not a row |')).toBe('\\| not a row |');
    expect(escapeMarkdown('---')).toBe('\\---');
  });
});
