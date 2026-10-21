import { describe, expect, it } from 'vitest';
import { parseSearchQuery, queryLeaves, toJsRegExp, type QueryNode } from './searchQuery';

// The same cases as the server's SearchQueryParserTest: both sides parse the grammar identically.
const word = (value: string, last = false): QueryNode => ({ type: 'leaf', kind: 'word', value, regex: false, last });
const leaf = (kind: 'phrase' | 'tag' | 'path' | 'file', value: string): QueryNode => ({ type: 'leaf', kind, value, regex: false, last: false });
const regex = (kind: 'regex' | 'path' | 'file' | 'tag', value: string): QueryNode => ({ type: 'leaf', kind, value, regex: true, last: false });
const and = (...children: QueryNode[]): QueryNode => ({ type: 'and', children });
const or = (...children: QueryNode[]): QueryNode => ({ type: 'or', children });
const not = (child: QueryNode): QueryNode => ({ type: 'not', child });

describe('parseSearchQuery', () => {
  it('parses the contract example', () => {
    expect(parseSearchQuery('"weekly review" tag:#work -draft')).toEqual(and(leaf('phrase', 'weekly review'), leaf('tag', '#work'), not(word('draft', true))));
  });

  it('lets OR bind looser than AND, only in upper case', () => {
    expect(parseSearchQuery('a b OR c')).toEqual(or(and(word('a'), word('b')), word('c', true)));
    expect(parseSearchQuery('cats or dogs')).toEqual(and(word('cats'), word('or'), word('dogs', true)));
    expect(parseSearchQuery('a OR')).toEqual(word('a'));
    expect(parseSearchQuery('OR a')).toEqual(word('a', true));
  });

  it('groups with parentheses and never fails on unbalanced ones', () => {
    expect(parseSearchQuery('-(draft OR wip) plan')).toEqual(and(not(or(word('draft'), word('wip'))), word('plan', true)));
    expect(parseSearchQuery('(a OR b')).toEqual(or(word('a'), word('b', true)));
    expect(parseSearchQuery('a) b')).toEqual(and(word('a)'), word('b', true)));
    expect(parseSearchQuery('()')).toBeNull();
    expect(parseSearchQuery('   ')).toBeNull();
  });

  it('reads regular expressions only when the closing slash ends the clause', () => {
    expect(parseSearchQuery('/colou?r/')).toEqual(regex('regex', 'colou?r'));
    expect(parseSearchQuery('file:/^\\d+/ path:/^Daily/')).toEqual(and(regex('file', '^\\d+'), regex('path', '^Daily')));
    expect(parseSearchQuery('/usr/bin')).toEqual(word('/usr/bin', true));
    expect(parseSearchQuery('/a\\/b/')).toEqual(regex('regex', 'a\\/b'));
  });

  it('parses line: and section: scopes', () => {
    expect(parseSearchQuery('line:(mix flour)')).toEqual({ type: 'scope', scope: 'line', child: and(word('mix'), word('flour', true)) });
    expect(parseSearchQuery('section:"open loops"')).toEqual({ type: 'scope', scope: 'section', child: leaf('phrase', 'open loops') });
    expect(parseSearchQuery('line: x')).toEqual(and(word('line:'), word('x', true)));
  });

  it('lists leaves with their negation', () => {
    const leaves = queryLeaves(parseSearchQuery('a -(b OR line:c)'));
    expect(leaves.map((l) => [l.leaf.value, l.negated, l.scoped])).toEqual([
      ['a', false, false],
      ['b', true, false],
      ['c', true, true],
    ]);
  });
});

describe('toJsRegExp', () => {
  it('is case-insensitive unless (?-i) turns it off, and skips what JavaScript cannot compile', () => {
    expect(toJsRegExp('colou?r')!.test('COLOR')).toBe(true);
    expect(toJsRegExp('(?-i)COLOR')!.test('color')).toBe(false);
    expect(toJsRegExp('(?-i)COLOR')!.test('COLOR')).toBe(true);
    expect(toJsRegExp('a(b')).toBeNull();
  });
});
