// fuzzysort wrappers (DESIGN §6.1: always `threshold: 0`).
import fuzzysort from 'fuzzysort';

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Ranks `items` by fuzzy match over `keys`; `boost` adjusts an item's score (e.g. +0.05 for notes). */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keys: ReadonlyArray<(item: T) => string>,
  limit: number,
  boost?: (item: T) => number,
): Ranked<T>[] {
  const results = fuzzysort.go(query, items, {
    keys: keys.map((k) => (item: T) => k(item)),
    threshold: 0,
    limit: boost ? 0 : limit,
  });
  const ranked = results.map((r) => ({ item: r.obj, score: r.score + (boost ? boost(r.obj) : 0) }));
  if (boost) ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

/** Ranks plain strings. */
export function fuzzyStrings(query: string, items: readonly string[], limit: number): string[] {
  return fuzzysort.go(query, items, { threshold: 0, limit }).map((r) => r.target);
}
