import { describe, expect, it } from 'vitest';
import { decodeLinkDestination, findTags, findWikiLinks, isInternalDestination, matchWikiLinkAt, parseMarkdownDestination, parseWikiBody } from './syntax';

// API.md §15.6 tag vectors. Exclusion zones (code, link text) are the parsers' job; the vectors
// that depend on them are covered in obsidianSyntax.test.ts and render.test.ts.
const TAG_VECTORS: Array<[string, string[]]> = [
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
];

describe('tags (API.md §15.6)', () => {
  it.each(TAG_VECTORS)('%s', (input, expected) => {
    expect(findTags(input).map((t) => t.tag)).toEqual(expected);
  });

  it('reports offsets of the # and the trimmed end', () => {
    expect(findTags('x #a/b/ y')).toEqual([{ tag: 'a/b', from: 2, to: 6 }]);
  });

  it('counts surrogate pairs as two code units', () => {
    expect(findTags('🙂 #x')).toEqual([{ tag: 'x', from: 3, to: 5 }]);
  });
});

// Wikilink body vectors; inputs are literal text, so `\\|` below is a backslash plus a pipe.
const WIKI_VECTORS: Array<[string, string, string | null, string | null, boolean]> = [
  ['[[Note]]', 'Note', null, null, false],
  ['[[ Note ]]', 'Note', null, null, false],
  ['[[Note\\|Alias]]', 'Note', null, 'Alias', false],
  ['[[Note#H1#H2\\|x]]', 'Note', 'H1#H2', 'x', false],
  ['[[#Heading]]', '', 'Heading', null, false],
  ['[[]]', '', null, null, false],
  ['[[Note#^abc]]', 'Note', '^abc', null, false],
  ['[[a|b|c]]', 'a', null, 'b|c', false],
  ['![[pic.png|300]]', 'pic.png', null, '300', true],
];

describe('wikilink bodies (API.md §15.6)', () => {
  it.each(WIKI_VECTORS)('%s', (input, target, subpath, display, embed) => {
    const [link] = findWikiLinks(input);
    expect(link).toMatchObject({ target, subpath, display, embed, raw: input, from: 0, to: input.length });
  });

  it('parseWikiBody splits at the first separator only', () => {
    expect(parseWikiBody('a#b|c|d')).toEqual({ target: 'a', subpath: 'b', display: 'c|d' });
  });

  it('matchWikiLinkAt mirrors the pattern', () => {
    expect(matchWikiLinkAt('x [[a]] y', 2)).toBe(7);
    expect(matchWikiLinkAt('![[a]]', 0)).toBe(6);
    expect(matchWikiLinkAt('[[a\nb]]', 0)).toBe(-1);
    expect(matchWikiLinkAt('[[a]b]]', 0)).toBe(-1);
    expect(matchWikiLinkAt('[[]]', 0)).toBe(4);
    expect(matchWikiLinkAt('[[a', 0)).toBe(-1);
  });
});

describe('markdown destinations', () => {
  it('percent-decodes but keeps +', () => {
    expect(decodeLinkDestination('Plan%20B+notes.md')).toBe('Plan B+notes.md');
    expect(decodeLinkDestination('bad%ZZ%E2')).toBe('bad%ZZ%E2');
  });

  it('detects internal destinations', () => {
    expect(isInternalDestination('Plan.md')).toBe(true);
    expect(isInternalDestination('https://e.com')).toBe(false);
    expect(isInternalDestination('mailto:x@y')).toBe(false);
    expect(isInternalDestination('//cdn.example/x.png')).toBe(false);
  });

  it('splits the subpath and keeps angle destinations verbatim', () => {
    expect(parseMarkdownDestination('Plan%20B.md#Risks')).toEqual({ target: 'Plan B.md', subpath: 'Risks' });
    expect(parseMarkdownDestination('<Plan B%20.md>')).toEqual({ target: 'Plan B%20.md', subpath: null });
    expect(parseMarkdownDestination('#Heading')).toEqual({ target: '', subpath: 'Heading' });
  });
});
