// Tags pane (DESIGN §6.2): every tag with its nested children, counted by notes (`total` includes
// descendants). A tag opens search with `tag:#tag`. Long lists are virtualized.
import { ChevronRight, Hash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTags } from '../../api/hooks';
import type { TagCount } from '../../api/types';
import { openTag } from '../../features/navigation';
import { isCoarsePointer } from '../../features/platform';
import { VirtualList } from '../VirtualList';

interface TagRow {
  tag: string;
  label: string;
  depth: number;
  total: number;
  hasChildren: boolean;
}

function visibleRows(tags: readonly TagCount[], expanded: ReadonlySet<string>): TagRow[] {
  const lower = tags.map((t) => t.tag.toLowerCase());
  const rows: TagRow[] = [];
  tags.forEach((t, i) => {
    const parts = t.tag.split('/');
    // Visible when every ancestor is expanded.
    for (let d = 1; d < parts.length; d++) if (!expanded.has(parts.slice(0, d).join('/').toLowerCase())) return;
    const hasChildren = i + 1 < tags.length && lower[i + 1].startsWith(lower[i] + '/');
    rows.push({ tag: t.tag, label: parts[parts.length - 1], depth: parts.length - 1, total: t.total, hasChildren });
  });
  return rows;
}

export default function TagsPanel() {
  const tags = useTags();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => visibleRows(tags.data?.tags ?? [], expanded), [tags.data, expanded]);
  const rowHeight = isCoarsePointer() ? 44 : 28;

  const toggle = (tag: string) => {
    const key = tag.toLowerCase();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (tags.isPending) return <div className="panel-empty">Loading…</div>;
  if (tags.isError) return <div className="panel-empty">Could not load tags.</div>;
  if (rows.length === 0) return <div className="panel-empty">No tags yet. Type #tag in a note.</div>;

  return (
    <VirtualList
      className="tags-list"
      role="list"
      aria-label="Tags"
      count={rows.length}
      rowHeight={rowHeight}
      renderRow={(i) => {
        const row = rows[i];
        return (
          <div role="listitem" className="tag-row" style={{ paddingInlineStart: 8 + row.depth * 16 }}>
            {row.hasChildren ? (
              <button
                type="button"
                className={`tree-chevron tag-chevron${expanded.has(row.tag.toLowerCase()) ? ' is-open' : ''}`}
                aria-label={expanded.has(row.tag.toLowerCase()) ? `Collapse ${row.tag}` : `Expand ${row.tag}`}
                title={expanded.has(row.tag.toLowerCase()) ? 'Collapse' : 'Expand'}
                aria-expanded={expanded.has(row.tag.toLowerCase())}
                onClick={() => toggle(row.tag)}
              >
                <ChevronRight size={14} />
              </button>
            ) : (
              <span className="tree-chevron is-empty" aria-hidden />
            )}
            <button type="button" className="tag-row-button" title={`Search tag:#${row.tag}`} onClick={() => openTag(row.tag)}>
              <Hash size={13} className="tree-icon" aria-hidden />
              <span className="tag-row-name">{row.label}</span>
              <span className="tag-row-count">{row.total}</span>
            </button>
          </div>
        );
      }}
    />
  );
}
