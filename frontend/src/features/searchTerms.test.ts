import { describe, expect, it } from 'vitest';
import { findTermRanges, highlightTerms } from './searchTerms';

describe('highlightTerms', () => {
  it('keeps positive words and phrases, lower-cased', () => {
    expect(highlightTerms('"Weekly Review" tag:#work -draft Plan')).toEqual(['weekly review', 'plan']);
  });

  it('skips filters, negations and an empty query, and dedupes', () => {
    expect(highlightTerms('path:Projects file:"plan b" -"old stuff" -x')).toEqual([]);
    expect(highlightTerms('   ')).toEqual([]);
    expect(highlightTerms('plan Plan PLAN')).toEqual(['plan']);
  });

  it('runs an unterminated phrase to the end', () => {
    expect(highlightTerms('"open loops')).toEqual(['open loops']);
  });

  it('understands OR, groups and scopes, and skips negated groups', () => {
    expect(highlightTerms('(cats OR dogs) -(fish OR birds) line:(mix flour)')).toEqual(['cats', 'dogs', 'mix', 'flour']);
  });

  it('turns positive regular expressions into RegExps', () => {
    const terms = highlightTerms('/colou?r/ -/x+/ file:/^a/');
    expect(terms).toHaveLength(1);
    expect(terms[0]).toBeInstanceOf(RegExp);
    expect((terms[0] as RegExp).source).toBe('colou?r');
  });
});

describe('findTermRanges', () => {
  it('finds case-insensitive, non-overlapping occurrences in order', () => {
    expect(findTermRanges('Plan a plan; planning', ['plan'])).toEqual([
      { from: 0, to: 4 },
      { from: 7, to: 11 },
      { from: 13, to: 17 },
    ]);
    expect(findTermRanges('weekly review', ['weekly review', 'review'])).toEqual([{ from: 0, to: 13 }]);
    expect(findTermRanges('nothing', [])).toEqual([]);
  });

  it('finds regular expression matches, skipping empty ones', () => {
    expect(findTermRanges('Color or colour, 555-1234', [/colou?r/gimu, /\d*/gmu])).toEqual([
      { from: 0, to: 5 },
      { from: 9, to: 15 },
      { from: 17, to: 20 },
      { from: 21, to: 25 },
    ]);
  });
});
