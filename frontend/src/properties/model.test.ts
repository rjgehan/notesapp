import { describe, expect, it } from 'vitest';
import { parsePropertyClause, parseSearchQuery, propertyClauseMatches } from '../features/searchQuery';
import { cleanTag, convert, fits, inferType, listItems, propertyQuery, registeredType, typeOf } from './model';

describe('properties/model', () => {
  it('infers types as the server does', () => {
    expect(inferType(true)).toBe('checkbox');
    expect(inferType(4)).toBe('number');
    expect(inferType(['a'])).toBe('multitext');
    expect(inferType('2026-10-21')).toBe('date');
    expect(inferType('2026-10-21T09:30')).toBe('datetime');
    expect(inferType('x')).toBe('text');
    expect(inferType(null)).toBeNull();
    expect(inferType('')).toBeNull();
  });

  it('takes the registry first (any case), then built-in types, then the value', () => {
    const registry = { Due: 'date', odd: 'colour' };
    expect(registeredType('due', registry)).toBe('date');
    expect(registeredType('odd', registry)).toBeNull();
    expect(typeOf('due', 'not a date', registry)).toBe('date');
    expect(typeOf('Tags', 'a b', registry)).toBe('tags');
    expect(typeOf('aliases', null, undefined)).toBe('aliases');
    expect(typeOf('n', 3, registry)).toBe('number');
    expect(typeOf('empty', null, registry)).toBe('text');
  });

  it('says whether a value fits, and converts what converts without loss', () => {
    expect(fits('date', 'soon')).toBe(false);
    expect(fits('number', '3')).toBe(false);
    expect(fits('tags', 'a, b')).toBe(true);
    expect(fits('multitext', [{ a: 1 }])).toBe(false);
    expect(fits('text', null)).toBe(true);
    expect(convert('3', 'number')).toBe(3);
    expect(convert('true', 'checkbox')).toBe(true);
    expect(convert('a', 'multitext')).toEqual(['a']);
    expect(convert(['a'], 'text')).toBe('a');
    expect(convert(['a', 'b'], 'text')).toBeUndefined();
    expect(convert('2026-10-21T09:30', 'date')).toBe('2026-10-21');
    expect(convert('soon', 'date')).toBeUndefined();
  });

  it('reads list items and cleans tags', () => {
    expect(listItems('tags', 'a, b c')).toEqual(['a', 'b', 'c']);
    expect(listItems('multitext', 'one, two')).toEqual(['one, two']);
    expect(listItems('multitext', [1, null, 'x'])).toEqual(['1', 'x']);
    expect(cleanTag(' #big idea ')).toBe('big-idea');
  });

  it('searches for a property with the bracket syntax', () => {
    expect(propertyQuery('due date')).toBe('[due date]');
    expect(propertyQuery('a:b')).toBe('"a:b"');
  });
});

describe('property search clauses (API.md §12.1)', () => {
  it('parses as the server does', () => {
    expect(parseSearchQuery('[status:in progress] -[draft]')).toEqual({
      type: 'and',
      children: [
        { type: 'leaf', kind: 'property', value: 'status:in progress', regex: false, last: false },
        { type: 'not', child: { type: 'leaf', kind: 'property', value: 'draft', regex: false, last: false } },
      ],
    });
    expect(parseSearchQuery('[a]b')).toEqual({ type: 'leaf', kind: 'word', value: '[a]b', regex: false, last: true });
    expect(parseSearchQuery('[:x]')).toBeNull();
    expect(parsePropertyClause('due:"2026"')).toEqual({ name: 'due', value: '2026', exact: true });
  });

  it('matches frontmatter as the server does', () => {
    const data = { Status: 'In Progress', related: ['[[Alpha]]', 'Beta'], rating: 4, done: true, empty: null };
    const m = (inside: string) => propertyClauseMatches(parsePropertyClause(inside)!, data);
    expect(m('status')).toBe(true);
    expect(m('status:progress')).toBe(true);
    expect(m('status:"progress"')).toBe(false);
    expect(m('related:alpha')).toBe(true);
    expect(m('rating:4')).toBe(true);
    expect(m('rating:40')).toBe(false);
    expect(m('done:true')).toBe(true);
    expect(m('empty:')).toBe(true);
    expect(m('status:')).toBe(false);
    expect(m('nope')).toBe(false);
  });
});

describe('[[ completion in property fields', () => {
  it('finds an unclosed [[ before the caret', async () => {
    const { openLinkAt } = await import('./links');
    expect(openLinkAt('See [[Bud', 9)).toEqual({ start: 4, query: 'Bud' });
    expect(openLinkAt('[[A]] and', 9)).toBeNull();
    expect(openLinkAt('[[A|b', 5)).toBeNull();
    expect(openLinkAt('plain', 5)).toBeNull();
  });
});
