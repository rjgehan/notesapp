// The words and phrases of a search query (API.md §12.1 grammar) that a hit view highlights:
// positive `word` and `"phrase"` clauses; filters (`tag:`, `path:`, `file:`) and negations are
// not highlighted.

export function highlightTerms(query: string): string[] {
  const terms: string[] = [];
  let i = 0;
  const q = query;
  const readValue = (): string => {
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const value = end < 0 ? q.slice(i + 1) : q.slice(i + 1, end);
      i = end < 0 ? q.length : end + 1;
      return value;
    }
    const start = i;
    while (i < q.length && !/\s/.test(q[i]) && q[i] !== '"') i++;
    return q.slice(start, i);
  };
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++;
    if (i >= q.length) break;
    let negated = false;
    if (q[i] === '-') {
      negated = true;
      i++;
    }
    const filter = /^(tag|path|file):/i.exec(q.slice(i));
    if (filter) i += filter[0].length;
    const value = readValue().trim();
    if (!filter && !negated && value) terms.push(value.toLowerCase());
  }
  return [...new Set(terms)];
}

/** Case-insensitive occurrences of `terms` in `text`, as sorted, non-overlapping ranges. */
export function findTermRanges(text: string, terms: readonly string[], limit = 500): Array<{ from: number; to: number }> {
  if (terms.length === 0) return [];
  const lower = text.toLowerCase();
  const ranges: Array<{ from: number; to: number }> = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0 && ranges.length < limit; at = lower.indexOf(term, at + term.length)) {
      ranges.push({ from: at, to: at + term.length });
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
