// Display helpers of the task views.
import type { TaskList } from '../../api/types';
import { findTags, findWikiLinks } from '../../features/syntax';

/** A list's color as CSS: '#rrggbb' or a lower-case color name (API.md §20.5), else null. */
export function listColor(list: Pick<TaskList, 'color'> | undefined): string | null {
  const c = list?.color;
  return c && (/^#[0-9a-f]{6}$/i.test(c) || /^[a-z]+$/.test(c)) ? c : null;
}

export type Segment = { kind: 'text'; text: string } | { kind: 'link'; text: string; target: string; subpath: string | null } | { kind: 'tag'; text: string; tag: string };

/** Splits a title into text, `[[links]]` and `#tags` (tags inside links are text). */
export function titleSegments(title: string): Segment[] {
  const marks: Array<{ from: number; to: number; seg: Segment }> = [];
  for (const l of findWikiLinks(title)) {
    marks.push({ from: l.from, to: l.to, seg: { kind: 'link', text: l.display ?? (l.subpath ? `${l.target} › ${l.subpath}` : l.target), target: l.target, subpath: l.subpath } });
  }
  for (const t of findTags(title)) {
    if (marks.some((m) => t.from >= m.from && t.from < m.to)) continue;
    marks.push({ from: t.from, to: t.to, seg: { kind: 'tag', text: title.slice(t.from, t.to), tag: t.tag } });
  }
  marks.sort((a, b) => a.from - b.from);
  const out: Segment[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.from > pos) out.push({ kind: 'text', text: title.slice(pos, m.from) });
    out.push(m.seg);
    pos = m.to;
  }
  if (pos < title.length) out.push({ kind: 'text', text: title.slice(pos) });
  return out;
}
