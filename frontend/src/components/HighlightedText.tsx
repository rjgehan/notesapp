import type { TextRange } from '../api/types';

/** Text with `ranges` (relative to `text`) wrapped in <mark>. */
export function HighlightedText({ text, ranges }: { text: string; ranges: readonly TextRange[] }) {
  const sorted = [...ranges].filter((r) => r.to > r.from && r.from < text.length).sort((a, b) => a.from - b.from);
  if (sorted.length === 0) return <>{text}</>;
  const parts: Array<string | { mark: string }> = [];
  let pos = 0;
  for (const r of sorted) {
    const from = Math.max(r.from, pos);
    const to = Math.min(r.to, text.length);
    if (to <= from) continue;
    if (from > pos) parts.push(text.slice(pos, from));
    parts.push({ mark: text.slice(from, to) });
    pos = to;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i} className="match">{p.mark}</mark>))}
    </>
  );
}
