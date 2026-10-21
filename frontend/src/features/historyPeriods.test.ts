import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '../api/types';
import { groupByDay, historyEntryOf, periodStart } from './historyPeriods';

describe('periodStart', () => {
  // Thursday, 2026-10-22 15:30 local time.
  const now = new Date(2026, 9, 22, 15, 30);

  it('starts periods at local midnight, weeks on Monday', () => {
    expect(periodStart('today', now)).toBe(new Date(2026, 9, 22).toISOString());
    expect(periodStart('week', now)).toBe(new Date(2026, 9, 19).toISOString());
    expect(periodStart('month', now)).toBe(new Date(2026, 9, 1).toISOString());
    expect(periodStart('30d', now)).toBe(new Date(2026, 8, 22).toISOString());
    expect(periodStart('all', now)).toBeUndefined();
  });

  it('treats Sunday as the end of the week', () => {
    expect(periodStart('week', new Date(2026, 9, 25, 9))).toBe(new Date(2026, 9, 19).toISOString());
    expect(periodStart('week', new Date(2026, 9, 19, 0, 5))).toBe(new Date(2026, 9, 19).toISOString());
  });
});

describe('groupByDay', () => {
  it('groups consecutive items of the same local day', () => {
    const t = (d: number, h: number) => ({ time: new Date(2026, 9, d, h).toISOString(), id: `${d}-${h}` });
    const groups = groupByDay([t(22, 18), t(22, 9), t(21, 23), t(20, 1)]);
    expect(groups.map((g) => [g.day, g.items.map((i) => i.id)])).toEqual([
      ['2026-10-22', ['22-18', '22-9']],
      ['2026-10-21', ['21-23']],
      ['2026-10-20', ['20-1']],
    ]);
  });
});

describe('historyEntryOf', () => {
  it('makes a history entry of a timeline file', () => {
    const commit: TimelineEntry = {
      commitId: 'c'.repeat(40),
      shortId: 'ccccccc',
      parentCommitId: 'p'.repeat(40),
      time: '2026-10-21T10:00:00.000Z',
      authorName: 'Alice',
      authorLogin: 'alice@github',
      message: 'Rename a.md → b.md',
      files: [],
      filesTotal: 1,
    };
    expect(historyEntryOf(commit, { path: 'b.md', change: 'renamed', renamedFrom: 'a.md' })).toEqual({
      commitId: commit.commitId,
      shortId: 'ccccccc',
      parentCommitId: commit.parentCommitId,
      path: 'b.md',
      time: commit.time,
      authorName: 'Alice',
      authorLogin: 'alice@github',
      message: 'Rename a.md → b.md',
      change: 'renamed',
      renamedFrom: 'a.md',
    });
  });
});
