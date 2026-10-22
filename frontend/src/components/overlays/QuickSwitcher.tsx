// Quick switcher (DESIGN §6.13, Mod-O): notes, aliases and other files ranked with fuzzysort
// (notes +0.05), recent files for an empty query, and a Create row when nothing matches exactly.
// Phones show it as a full-screen sheet with a "Search in notes" row.
import { FilePlus, FileText, Forward, Search, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTree } from '../../api/hooks';
import { flattenItems } from '../../features/bookmarks';
import { useBookmarks } from '../../features/bookmarkStore';
import { createNamedNote } from '../../features/fileOps';
import { afterOpen } from '../../features/focus';
import { activePath, openPath, openSearch } from '../../features/navigation';
import { keyLabel } from '../../features/platform';
import { recentPaths } from '../../features/recent';
import { switcherItems, type SwitcherItem } from '../../features/switcher';
import { useUi } from '../../state/ui';
import { viewFor } from '../../views/registry';
import { useBreakpoint } from '../layout/useBreakpoint';
import { Picker } from './Picker';

function ItemRow({ item, starred }: { item: SwitcherItem; starred: boolean }) {
  const Icon = item.kind === 'create' ? FilePlus : item.kind === 'search' ? Search : item.kind === 'alias' ? Forward : item.entry ? viewFor(item.entry).icon : FileText;
  return (
    <>
      <Icon size={16} className="picker-item-icon" aria-hidden />
      <span className="picker-item-text">
        <span className="picker-item-label">{item.label}</span>
        {item.detail && <span className="picker-item-detail">{item.detail}</span>}
      </span>
      {starred && <Star size={13} className="picker-item-star" aria-label="Bookmarked" />}
      {item.kind === 'create' && <kbd className="picker-kbd">⇧↵</kbd>}
    </>
  );
}

export function QuickSwitcher() {
  const tree = useTree().data;
  const phone = useBreakpoint() === 'phone';
  const [query, setQuery] = useState('');
  const [recent] = useState(recentPaths);
  const { items: bookmarks } = useBookmarks();
  const starred = useMemo(
    () => new Set(flattenItems(bookmarks).flatMap(({ item }) => (item.type === 'file' && !item.subpath && typeof item.path === 'string' ? [item.path.toLowerCase()] : []))),
    [bookmarks],
  );
  const items = useMemo(() => (tree ? switcherItems(tree, query, recent, phone) : []), [tree, query, recent, phone]);
  const close = () => useUi.getState().setOverlay(null);

  const create = (viaKeyboard: boolean) => {
    const name = query.trim();
    if (!name) return;
    close();
    void createNamedNote(name, activePath(), viaKeyboard);
  };

  const pick = (item: SwitcherItem, opts: { shift: boolean; viaKeyboard: boolean }) => {
    if (opts.shift || item.kind === 'create') {
      create(opts.viaKeyboard);
      return;
    }
    close();
    if (item.kind === 'search') {
      // The search field takes the focus, so it never stays on the switcher's trigger (§6.19).
      useUi.getState().requestSearchFocus();
      openSearch(item.path);
      return;
    }
    afterOpen(item.path, opts.viaKeyboard);
    openPath(item.path);
  };

  return (
    <Picker
      label="Quick switcher"
      placeholder="Find or create a note…"
      query={query}
      onQuery={setQuery}
      items={items}
      itemKey={(i) => i.key}
      renderItem={(i) => <ItemRow item={i} starred={(i.kind === 'note' || i.kind === 'file') && starred.has(i.path.toLowerCase())} />}
      onPick={pick}
      onClose={close}
      empty={query.trim() === '' ? 'No recently opened files.' : null}
      footer={
        <>
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>⇧↵</kbd> create
          </span>
          {!phone && (
            <span>
              <kbd>{keyLabel('Mod')}↵</kbd> new tab
            </span>
          )}
          <span>
            <kbd>esc</kbd> close
          </span>
        </>
      }
    />
  );
}
