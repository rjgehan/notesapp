// The Properties panel (ROADMAP item 13, DESIGN §6.38): every property of the vault with the
// number of notes that have it and its type. A row searches for the notes with the property
// (`[name]`); its menu changes the vault-wide type, renames the property in every note, or
// forgets its type. A filter narrows the list; it sorts by name or by count.
import { ArrowDownAZ, ArrowDownWideNarrow, MoreHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PropertyInfo } from '../../api/types';
import { openContextMenu } from '../../components/overlays/openContextMenu';
import type { MenuEntry } from '../../components/overlays/ContextMenu';
import { VirtualList } from '../../components/VirtualList';
import { toastError } from '../../features/errors';
import { openSearch } from '../../features/navigation';
import { isCoarsePointer } from '../../features/platform';
import { setPropertyType, useVaultProperties } from '../api';
import { PROPERTY_TYPES, propertyQuery, TYPE_LABELS } from '../model';
import { renameAcrossVault } from '../rename';
import { TypeIcon } from './TypeIcon';
import '../properties.css';

function menuFor(p: PropertyInfo): MenuEntry[] {
  const shown = p.type ?? p.inferred;
  const setType = (type: (typeof PROPERTY_TYPES)[number] | null) => () => void setPropertyType(p.name, type).catch((e: unknown) => toastError(e, 'Property type'));
  return [
    { id: 'search', label: 'Search notes with this property', run: () => openSearch(propertyQuery(p.name)) },
    { id: 'rename', label: 'Rename in every note…', run: () => void renameAcrossVault(p.name) },
    'separator',
    ...PROPERTY_TYPES.map((t) => ({ id: `type-${t}`, label: `${t === shown ? '✓ ' : ''}${TYPE_LABELS[t]}${t === shown && !p.type ? ' (from values)' : ''}`, icon: <TypeIcon type={t} />, run: setType(t) })),
    ...(p.type ? (['separator', { id: 'forget', label: 'Forget the type (use the values)', run: setType(null) }] as MenuEntry[]) : []),
  ];
}

export default function PropertiesPanel() {
  const list = useVaultProperties();
  const [filter, setFilter] = useState('');
  const [byCount, setByCount] = useState(false);
  const rowHeight = isCoarsePointer() ? 44 : 28;
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const items = (list.data?.properties ?? []).filter((p) => q === '' || p.name.toLowerCase().includes(q));
    return byCount ? [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) : items;
  }, [list.data, filter, byCount]);

  return (
    <div className="properties-panel">
      <div className="panel-toolbar properties-panel-toolbar" role="toolbar" aria-label="Properties">
        <input
          type="search"
          className="search-input properties-filter"
          placeholder="Filter properties"
          aria-label="Filter properties"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-pressed={byCount}
          aria-label={byCount ? 'Sort by name' : 'Sort by count'}
          title={byCount ? 'Sort by name' : 'Sort by count'}
          onClick={() => setByCount(!byCount)}
        >
          {byCount ? <ArrowDownAZ size={16} aria-hidden /> : <ArrowDownWideNarrow size={16} aria-hidden />}
        </button>
      </div>
      {list.isPending ? (
        <div className="panel-empty">Loading…</div>
      ) : list.isError ? (
        <div className="panel-empty">Could not load properties.</div>
      ) : rows.length === 0 ? (
        <div className="panel-empty">{filter ? 'No property matches.' : 'No properties yet. Add one at the top of a note.'}</div>
      ) : (
        <VirtualList
          className="tags-list properties-panel-list"
          role="list"
          aria-label="Properties"
          count={rows.length}
          rowHeight={rowHeight}
          renderRow={(i) => {
            const p = rows[i];
            const type = p.type ?? p.inferred;
            return (
              <div role="listitem" className="tag-row property-panel-row">
                <button type="button" className="tag-row-button" title={`Search ${propertyQuery(p.name)}`} onClick={() => openSearch(propertyQuery(p.name))}>
                  <span className={`property-panel-icon${p.type ? ' is-registered' : ''}`} title={`${TYPE_LABELS[type]}${p.type ? '' : ' (from its values)'}`}>
                    <TypeIcon type={type} size={13} />
                  </span>
                  <span className="tag-row-name">{p.name}</span>
                  <span className="tag-row-count" aria-label={`${p.count} ${p.count === 1 ? 'note' : 'notes'}`}>
                    {p.count}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button property-panel-menu"
                  aria-label={`${p.name} actions`}
                  title="Type, rename"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openContextMenu({ x: r.left, y: r.bottom + 2 }, `Property ${p.name}`, menuFor(p));
                  }}
                >
                  <MoreHorizontal size={14} aria-hidden />
                </button>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
