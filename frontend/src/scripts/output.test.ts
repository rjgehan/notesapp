import { describe, expect, it } from 'vitest';
import { renderNote } from '../render/render';
import { outputMarkdown } from './output';

const ctx = { sourcePath: 'Here.md', resolve: () => null, rawUrl: () => '', strictLineBreaks: false, loadRemoteImages: false, depth: 0 };

function html(md: string): string {
  const div = document.createElement('div');
  div.appendChild(renderNote(md, ctx).fragment);
  return div.innerHTML;
}

describe('script output as Markdown (ROADMAP 40)', () => {
  it('escapes text, keeps Markdown, and writes links and embeds as wikilinks', () => {
    expect(outputMarkdown([{ t: 'text', v: '**not bold** [[x]] <b>' }])).toBe('\\*\\*not bold\\*\\* \\[\\[x\\]\\] \\<b\\>');
    expect(outputMarkdown([{ t: 'md', v: '**bold**' }, { t: 'link', path: 'P/A.md', title: 'A' }, { t: 'embed', target: 'Monday notes' }])).toBe('**bold**\n\n[[P/A.md|A]]\n\n![[Monday notes]]');
    // A path or title cannot break out of the wikilink.
    expect(outputMarkdown([{ t: 'link', path: 'a]]<img src=x onerror=alert(1)>[[b', title: 'x|y' }])).toBe('[[a  <img src=x onerror=alert(1)>  b|x y]]');
  });

  it('writes lists and tables, escaping pipes in cells', () => {
    const md = outputMarkdown([
      { t: 'list', items: [{ t: 'text', v: 'one' }, { t: 'inline', items: [{ t: 'link', path: 'A.md', title: 'A' }, { t: 'text', v: 'x' }] }] },
      { t: 'table', columns: ['Name', 'Note'], rows: [[{ t: 'text', v: 'a|b' }, { t: 'link', path: 'A.md', title: 'A' }]] },
    ]);
    expect(md).toBe('- one\n- [[A.md|A]] — x\n\n| Name | Note |\n| --- | --- |\n| a\\|b | [[A.md\\|A]] |');
  });

  it('renders through the reading pipeline: no script, no remote image, text stays text', () => {
    const out = html(outputMarkdown([{ t: 'md', v: '<img src="https://evil.example/x.png" onerror="alert(1)"> <script>alert(1)</script> ![t](https://evil.example/p.png?d=secret)' }, { t: 'text', v: '<b>x</b>' }]));
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).not.toMatch(/<img[^>]+evil\.example/);
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('fences code with more backticks than it holds', () => {
    expect(outputMarkdown([{ t: 'code', v: 'a ``` b' }])).toBe('````\na ``` b\n````');
  });
});
