// The collapsible "Properties" table of a note's frontmatter (DESIGN §6.6.1, §6.7 #7), shown by
// Live Preview. Its edit button shows the YAML for editing (a typed editor is ROADMAP 13).
import { Calendar, ChevronDown, ChevronRight, Hash, Link2, List, Pencil, ToggleLeft, Type } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useTree } from '../../api/hooks';
import { parseFrontmatter } from '../../features/frontmatter';
import { resolve } from '../../features/links';
import { openLink, openTag } from '../../features/navigation';
import { findWikiLinks } from '../../features/syntax';

const COLLAPSE_KEY = 'notesapp:propertiesCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function TextWithLinks({ text, sourcePath }: { text: string; sourcePath: string }) {
  const tree = useTree().data;
  const links = findWikiLinks(text);
  if (links.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  links.forEach((l, i) => {
    if (l.from > pos) parts.push(text.slice(pos, l.from));
    const resolved = tree ? resolve(l.target, sourcePath, tree.links) : null;
    parts.push(
      <a
        key={i}
        href="#"
        className={resolved ? 'internal-link' : 'internal-link is-unresolved'}
        onClick={(e) => {
          e.preventDefault();
          void openLink(l.target, l.subpath, sourcePath);
        }}
      >
        {l.display ?? (l.subpath ? `${l.target} > ${l.subpath}` : l.target)}
      </a>,
    );
    pos = l.to;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

function Value({ name, value, sourcePath }: { name: string; value: unknown; sourcePath: string }) {
  const isTags = ['tags', 'tag'].includes(name.toLowerCase());
  if (Array.isArray(value) || (isTags && typeof value === 'string')) {
    const items = Array.isArray(value) ? value : value.split(/[,\s]+/).filter(Boolean);
    return (
      <div className="property-chips">
        {items.map((item, i) =>
          isTags ? (
            <a
              key={i}
              href="#"
              className="tag"
              onClick={(e) => {
                e.preventDefault();
                openTag(String(item).replace(/^#/, ''));
              }}
            >
              #{String(item).replace(/^#/, '')}
            </a>
          ) : (
            <span key={i} className="property-chip">
              {typeof item === 'string' ? <TextWithLinks text={item} sourcePath={sourcePath} /> : JSON.stringify(item)}
            </span>
          ),
        )}
      </div>
    );
  }
  if (value === null || value === undefined) return <span className="property-empty">Empty</span>;
  if (typeof value === 'boolean') return <input type="checkbox" checked={value} readOnly disabled aria-label={name} />;
  if (typeof value === 'object') return <code className="property-json">{JSON.stringify(value)}</code>;
  return <TextWithLinks text={String(value)} sourcePath={sourcePath} />;
}

function iconFor(name: string, value: unknown) {
  if (['tags', 'tag'].includes(name.toLowerCase())) return <Hash size={14} aria-hidden />;
  if (Array.isArray(value)) return <List size={14} aria-hidden />;
  if (typeof value === 'boolean') return <ToggleLeft size={14} aria-hidden />;
  if (typeof value === 'number') return <Hash size={14} aria-hidden />;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return <Calendar size={14} aria-hidden />;
  if (typeof value === 'string' && value.includes('[[')) return <Link2 size={14} aria-hidden />;
  return <Type size={14} aria-hidden />;
}

/**
 * A note's properties. In Live Preview (ROADMAP 10b) `onEdit` adds an edit button, which shows the
 * frontmatter's YAML in the editor; empty properties then still show, to be edited.
 */
export function PropertiesTable({ yaml, sourcePath, onEdit = null }: { yaml: string; sourcePath: string; onEdit?: (() => void) | null }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const parsed = useMemo(() => parseFrontmatter(yaml), [yaml]);
  const entries = parsed.data ? Object.entries(parsed.data) : [];
  if (parsed.data && entries.length === 0 && !onEdit) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // Collapsing is a convenience only.
    }
  };

  return (
    <section className="properties" aria-label="Properties">
      <div className="properties-header">
        <button type="button" className="properties-heading" aria-expanded={!collapsed} onClick={toggle}>
          {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          Properties
        </button>
        {onEdit && (
          <button
            type="button"
            className="icon-button properties-edit"
            aria-label="Edit properties"
            title="Edit properties"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onEdit}
          >
            <Pencil size={14} aria-hidden />
          </button>
        )}
      </div>
      {!collapsed &&
        (parsed.error ? (
          <div className="properties-error" role="note">
            Invalid frontmatter: {parsed.error}
          </div>
        ) : entries.length === 0 ? (
          <div className="property-empty">No properties</div>
        ) : (
          <dl className="properties-list">
            {entries.map(([key, value]) => (
              <Fragment key={key}>
                <dt>
                  {iconFor(key, value)}
                  <span>{key}</span>
                </dt>
                <dd>
                  <Value name={key} value={value} sourcePath={sourcePath} />
                </dd>
              </Fragment>
            ))}
          </dl>
        ))}
    </section>
  );
}
