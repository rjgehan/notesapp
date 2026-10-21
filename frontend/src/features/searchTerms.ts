// What a search hit view highlights for a query (API.md §12.1 grammar): the words and phrases of
// positive clauses (lower-cased), and positive /regular expressions/ over the text. Filters
// (`tag:`, `path:`, `file:`) and negated clauses are not highlighted.
import { parseSearchQuery, queryLeaves, toJsRegExp } from './searchQuery';

export type HighlightTerm = string | RegExp;

export function highlightTerms(query: string): HighlightTerm[] {
  const words: string[] = [];
  const regexes: RegExp[] = [];
  for (const { leaf, negated } of queryLeaves(parseSearchQuery(query))) {
    if (negated) continue;
    if (leaf.kind === 'word' || leaf.kind === 'phrase') {
      const value = leaf.value.trim().toLowerCase();
      if (value) words.push(value);
    } else if (leaf.kind === 'regex') {
      const re = toJsRegExp(leaf.value);
      if (re && !regexes.some((r) => r.source === re.source && r.flags === re.flags)) regexes.push(re);
    }
  }
  return [...new Set(words), ...regexes];
}

/** Occurrences of `terms` in `text` (strings case-insensitively), as sorted, non-overlapping ranges. */
export function findTermRanges(text: string, terms: readonly HighlightTerm[], limit = 500): Array<{ from: number; to: number }> {
  if (terms.length === 0) return [];
  let lower: string | null = null;
  const ranges: Array<{ from: number; to: number }> = [];
  for (const term of terms) {
    if (typeof term === 'string') {
      lower ??= text.toLowerCase();
      for (let at = lower.indexOf(term); at >= 0 && ranges.length < limit; at = lower.indexOf(term, at + term.length)) {
        ranges.push({ from: at, to: at + term.length });
      }
      continue;
    }
    const re = new RegExp(term.source, term.flags.includes('g') ? term.flags : term.flags + 'g');
    for (let m = re.exec(text); m && ranges.length < limit; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push({ from: m.index, to: m.index + m[0].length });
    }
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Array<{ from: number; to: number }> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.from < last.to) continue;
    out.push(r);
  }
  return out;
}
