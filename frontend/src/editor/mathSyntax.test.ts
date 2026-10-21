import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { MathSyntax } from './mathSyntax';
import { ObsidianSyntax } from './obsidianSyntax';

const parser = (markdownLanguage.parser as MarkdownParser).configure([ObsidianSyntax, MathSyntax]);

/** Names and texts of nodes of the given types, in document order. */
function nodes(text: string, ...types: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  parser.parse(text).iterate({
    enter(node) {
      if (types.includes(node.name)) out.push([node.name, text.slice(node.from, node.to)]);
    },
  });
  return out;
}

const inline = (text: string) => nodes(text, 'InlineMath').map(([, t]) => t);

describe('MathSyntax: inline (the reading view\'s delimiter rules)', () => {
  it.each([
    ['$x^2$', ['$x^2$']],
    ['a $x$, $y$.', ['$x$', '$y$']],
    ['Costs $5 and $10 today.', []],
    ['$ x$ and $x $', []],
    ['\\$x$', []],
    ['`$code$`', []],
    ['$a \\$ b$', ['$a \\$ b$']],
    ['Display $$\\sum x$$ inline', ['$$\\sum x$$']],
  ])('%s', (input, expected) => {
    expect(inline(input)).toEqual(expected);
  });

  it('hides links, tags and emphasis inside math', () => {
    expect(nodes('$a_1 * b_2 [[x]] #tag$', 'WikiLink', 'Hashtag', 'Emphasis')).toEqual([]);
  });
});

describe('MathSyntax: blocks', () => {
  it('parses a $$ block with its marks', () => {
    const text = 'Before\n\n$$\n\\int_0^1 x\\,dx\n$$\nAfter';
    expect(nodes(text, 'BlockMath')).toEqual([['BlockMath', '$$\n\\int_0^1 x\\,dx\n$$']]);
    expect(nodes(text, 'BlockMathMark').map(([, t]) => t)).toEqual(['$$', '$$']);
    expect(nodes(text, 'Paragraph').map(([, t]) => t)).toEqual(['Before', 'After']);
  });

  it('parses one-line blocks, and interrupts a paragraph', () => {
    expect(nodes('$$ E = mc^2 $$', 'BlockMath')).toEqual([['BlockMath', '$$ E = mc^2 $$']]);
    expect(nodes('Text\n$$\nx\n$$', 'BlockMath', 'Paragraph')).toEqual([
      ['Paragraph', 'Text'],
      ['BlockMath', '$$\nx\n$$'],
    ]);
  });

  it('treats `$$x$$ more` as inline math in a paragraph', () => {
    expect(nodes('$$x$$ more', 'BlockMath', 'InlineMath')).toEqual([['InlineMath', '$$x$$']]);
  });

  it('works inside callouts and ends with the quote', () => {
    const text = '> [!note]\n> $$\n> a + b\n> $$\n\nAfter';
    expect(nodes(text, 'BlockMath')).toEqual([['BlockMath', '$$\n> a + b\n> $$']]);
    expect(nodes('> $$\n> a\n\nOutside', 'BlockMath', 'Paragraph')).toEqual([
      ['BlockMath', '$$\n> a'],
      ['Paragraph', 'Outside'],
    ]);
  });
});
