import { markdownLanguage } from '@codemirror/lang-markdown';
import { parser as baseParser, type MarkdownParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { ObsidianSyntax } from './obsidianSyntax';

const parser = (markdownLanguage.parser as MarkdownParser).configure([ObsidianSyntax]);

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

const tags = (text: string) => nodes(text, 'Hashtag').map(([, t]) => t.slice(1));

describe('ObsidianSyntax: tags (API.md §15.6)', () => {
  it.each([
    ['#project', ['project']],
    ['#Project/Alpha', ['Project/Alpha']],
    ['#a/b/', ['a/b']],
    ['#1984', []],
    ['#y1984', ['y1984']],
    ['a#b', []],
    ['#🚀 launch', ['🚀']],
    ['#don’t', ['don’t']],
    ["#don't", ['don']],
    ['#tag.', ['tag']],
    ['# Heading #tag', ['tag']],
    ['[see #x](https://e.com)', []],
    ['`#code`', []],
  ])('%s', (input, expected) => {
    expect(tags(input)).toEqual(expected);
  });

  it('finds tags on continuation lines of a paragraph', () => {
    expect(tags('first line\n#second')).toEqual(['second']);
  });
});

describe('ObsidianSyntax: wikilinks', () => {
  const parts = (input: string) => nodes(input, 'WikiLinkTarget', 'WikiLinkAlias').map(([n, t]) => `${n}:${t}`);

  it.each([
    ['[[Note]]', ['WikiLinkTarget:Note']],
    ['[[ Note ]]', ['WikiLinkTarget: Note ']],
    ['[[Note\\|Alias]]', ['WikiLinkTarget:Note', 'WikiLinkAlias:Alias']],
    ['[[Note#H1#H2\\|x]]', ['WikiLinkTarget:Note#H1#H2', 'WikiLinkAlias:x']],
    ['[[#Heading]]', ['WikiLinkTarget:#Heading']],
    ['[[]]', []],
    ['[[a|b|c]]', ['WikiLinkTarget:a', 'WikiLinkAlias:b|c']],
  ])('%s', (input, expected) => {
    expect(nodes(input, 'WikiLink')).toEqual([['WikiLink', input]]);
    expect(parts(input)).toEqual(expected);
  });

  it('parses embeds', () => {
    expect(nodes('![[pic.png|300]]', 'Embed', 'Image')).toEqual([['Embed', '![[pic.png|300]]']]);
  });

  it('does not parse wikilinks in code', () => {
    expect(nodes('`[[x]]`\n\n```\n[[y]]\n```', 'WikiLink')).toEqual([]);
  });

  it('rejects bodies with brackets or newlines', () => {
    expect(nodes('[[a[b]]', 'WikiLink')).toEqual([]);
    expect(nodes('[[a\nb]]', 'WikiLink')).toEqual([]);
  });

  it('keeps standard links working', () => {
    expect(nodes('[x](y.md)', 'Link')).toEqual([['Link', '[x](y.md)']]);
  });
});

describe('ObsidianSyntax: highlight and comments', () => {
  it('parses ==highlight==', () => {
    expect(nodes('a ==marked== b', 'Highlight')).toEqual([['Highlight', '==marked==']]);
  });

  it('parses inline %%comments%%', () => {
    expect(nodes('a %%hidden [[x]]%% b', 'Comment', 'WikiLink')).toEqual([['Comment', '%%hidden [[x]]%%']]);
  });

  it('parses block comments across blank lines', () => {
    const text = 'before\n\n%%\nhidden #tag\n\nmore\n%%\n\nafter #ok';
    expect(nodes(text, 'CommentBlock').map(([, t]) => t)).toEqual(['%%\nhidden #tag\n\nmore\n%%']);
    expect(tags(text)).toEqual(['ok']);
  });

  it('extends the base parser without breaking it', () => {
    expect(baseParser.configure([ObsidianSyntax]).parse('# x').topNode.name).toBe('Document');
  });
});
