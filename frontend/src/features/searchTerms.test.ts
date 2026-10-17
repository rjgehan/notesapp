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
});
