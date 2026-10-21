// Bookmarks pane (ROADMAP item 12, DESIGN §6.23): starred notes, headings, folders and searches in
// Obsidian's format, synced through the vault. Groups collapse (remembered per device), rows open
// their target, a missing target (deleted, or moved outside the app) is dimmed until it comes back,
// and the row menu renames, reorders, moves into a group and removes. On desktop rows can be
// dragged to reorder, and explorer rows dropped in to bookmark them.
import {
  ArrowDown,
  ArrowUp,
  BookmarkMinus,
  BookmarkPlus,
  ChevronRight,
  ChevronsDownUp,
  Ellipsis,
  ExternalLink,
  FileText,
  Folder,
  FolderInput,
  FolderOutput,
  FolderPlus,
  Globe,
  Heading,
  Pencil,
  Pilcrow,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTree } from '../../api/hooks';
import type { BookmarkItem } from '../../api/types';
import type { VaultTree } from '../../api/vaultTree';
import { INTERNAL_PATH_TYPE } from '../../editor/pasteAndDrop';
import { bookmarkLabel, fileBookmark, folderBookmark, groupsOf, insertAt, isGroup, itemAt, moveItem, removeAt, shiftItem, subpathTarget, type PlacedItem } from '../../features/bookmarks';
import { editBookmarks, isFileBookmarked, promptNewGroup, toggleFileBookmark, useBookmarks } from '../../features/bookmarkStore';
import { isKeyboardClick } from '../../features/focus';
import { isCoarsePointer } from '../../features/platform';
import { displayName, folderOf } from '../../features/paths';
import { toast } from '../../state/toasts';
import { viewFor } from '../../views/registry';
import { ContextMenu, type MenuEntry } from '../overlays/ContextMenu';
import { bookmarkTarget, describeBookmark, dropPlace, groupKey, isMissing, openBookmark, removeGroup, renameBookmark, visibleRows } from './bookmarkRows';
import { useRowMenu } from './useRowMenu';

const BOOKMARK_DRAG_TYPE = 'application/x-notesapp-bookmark';
const COLLAPSED_KEY = 'notesapp:bookmarkGroupsCollapsed';

function readCollapsed(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Collapsed groups, per device. */
function useCollapsedGroups(): [ReadonlySet<string>, (key: string, collapsed: boolean) => void, (keys: string[]) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const save = (next: Set<string>) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // A per-device convenience only.
    }
  };
  const set = (key: string, value: boolean) => {
    const next = new Set(collapsed);
    if (value) next.add(key);
    else next.delete(key);
    save(next);
  };
  return [collapsed, set, (keys) => save(new Set([...collapsed, ...keys]))];
}

function ItemIcon({ item, tree }: { item: BookmarkItem; tree: VaultTree | undefined }) {
  const props = { size: 15, className: 'tree-icon', 'aria-hidden': true } as const;
  switch (item.type) {
    case 'file': {
      const sub = subpathTarget(item);
      if (sub) return sub.split('#').pop()?.startsWith('^') ? <Pilcrow {...props} /> : <Heading {...props} />;
      const target = bookmarkTarget(item, tree);
      const entry = target ? tree?.byPath.get(target) : undefined;
      const Icon = entry ? viewFor(entry).icon : FileText;
      return <Icon {...props} />;
    }
    case 'folder':
      return <Folder {...props} />;
    case 'search':
      return <Search {...props} />;
    case 'url':
      return <Globe {...props} />;
    default:
      return <Star {...props} />;
  }
}

function menuItems(row: PlacedItem, all: readonly BookmarkItem[], tree: VaultTree | undefined): MenuEntry[] {
  const { item, path } = row;
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  const siblings = parent.length === 0 ? all : (itemAt(all, parent)?.items ?? []);
  const group = isGroup(item);
  const entries: MenuEntry[] = [];
  if (!group) entries.push({ id: 'open', label: 'Open', icon: <ExternalLink size={16} />, run: () => openBookmark(item, tree, path) });
  entries.push({ id: 'rename', label: group ? 'Rename group…' : 'Rename…', icon: <Pencil size={16} />, run: () => void renameBookmark(item, path) });
  if (group) entries.push({ id: 'new-group', label: 'New group inside', icon: <FolderPlus size={16} />, run: () => void promptNewGroup(path) });
  entries.push('separator');
  entries.push({ id: 'up', label: 'Move up', icon: <ArrowUp size={16} />, disabled: index === 0, run: () => void editBookmarks((items) => shiftItem(items, path, -1)) });
  entries.push({ id: 'down', label: 'Move down', icon: <ArrowDown size={16} />, disabled: index >= siblings.length - 1, run: () => void editBookmarks((items) => shiftItem(items, path, 1)) });
  if (parent.length > 0) {
    entries.push({ id: 'out', label: 'Move out of the group', icon: <FolderOutput size={16} />, run: () => void editBookmarks((items) => moveItem(items, path, parent.slice(0, -1), parent[parent.length - 1] + 1)) });
  }
  const targets = groupsOf(all)
    // Not the group it is in, and never itself or a group inside it.
    .filter((g) => !(g.path.length === parent.length && g.path.every((v, i) => v === parent[i])))
    .filter((g) => !(g.path.length >= path.length && path.every((v, i) => g.path[i] === v)))
    .slice(0, 12);
  for (const g of targets) {
    entries.push({
      id: `to:${g.path.join('.')}`,
      label: `Move to “${bookmarkLabel(g.item)}”`,
      icon: <FolderInput size={16} />,
      run: () => void editBookmarks((items) => moveItem(items, path, g.path, Number.MAX_SAFE_INTEGER)),
    });
  }
  entries.push('separator');
  if (group) entries.push({ id: 'remove-group', label: 'Remove group (keep its bookmarks)', icon: <Trash2 size={16} />, danger: true, run: () => void removeGroup(path) });
  else entries.push({ id: 'remove', label: 'Remove bookmark', icon: <Trash2 size={16} />, danger: true, run: () => void editBookmarks((items) => removeAt(items, path)) });
  return entries;
}

export default function BookmarksPanel({ activePath }: { activePath: string | null }) {
  const { items, isPending, isError } = useBookmarks();
  const tree = useTree().data;
  const [collapsed, setCollapsed, collapseAll] = useCollapsedGroups();
  const { menu, close, rowHandlers, swallowClick, openAt } = useRowMenu<PlacedItem>();
  const [dropKey, setDropKey] = useState<string | null>(null);
  const coarse = isCoarsePointer();
  const rows = visibleRows(items, collapsed);
  const activeStarred = activePath !== null && isFileBookmarked(items, activePath);

  const activate = (row: PlacedItem, viaKeyboard: boolean) => {
    if (isGroup(row.item)) setCollapsed(groupKey(row.item), !collapsed.has(groupKey(row.item)));
    else openBookmark(row.item, tree, row.path, viaKeyboard);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: PlacedItem) => {
    const el = e.currentTarget;
    switch (e.key) {
      case 'Enter':
      case ' ':
        activate(row, true);
        break;
      case 'ArrowDown':
        (el.nextElementSibling as HTMLElement | null)?.focus();
        break;
      case 'ArrowUp':
        (el.previousElementSibling as HTMLElement | null)?.focus();
        break;
      case 'ArrowRight':
      case 'ArrowLeft':
        if (!isGroup(row.item)) return;
        setCollapsed(groupKey(row.item), e.key === 'ArrowLeft');
        break;
      case 'F2':
        void renameBookmark(row.item, row.path);
        break;
      case 'Delete':
        void (isGroup(row.item) ? removeGroup(row.path) : editBookmarks((list) => removeAt(list, row.path)));
        break;
      case 'ContextMenu':
        openAt(row, el);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // ---------- drag and drop (desktop) ----------

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE) || e.dataTransfer.types.includes(INTERNAL_PATH_TYPE);

  const onDragOver = (e: DragEvent, row: PlacedItem | null) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE) ? 'move' : 'link';
    const key = row ? row.path.join('.') : '';
    if (dropKey !== key) setDropKey(key);
  };

  const onDrop = (e: DragEvent, row: PlacedItem | null) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropKey(null);
    const { parent, index } = dropPlace(row);
    const moving = e.dataTransfer.getData(BOOKMARK_DRAG_TYPE);
    if (moving) {
      const from = JSON.parse(moving) as number[];
      void editBookmarks((list) => moveItem(list, from, parent, index));
      return;
    }
    const path = e.dataTransfer.getData(INTERNAL_PATH_TYPE);
    if (!path) return;
    const item = tree?.folderPaths.has(path) ? folderBookmark(path) : fileBookmark(path);
    toast(`Bookmarked “${displayName(path)}”`);
    void editBookmarks((list) => insertAt(list, parent, item, index));
  };

  const renderRow = (row: PlacedItem): ReactNode => {
    const { item, path, depth } = row;
    const key = path.join('.');
    const group = isGroup(item);
    const open = group && !collapsed.has(groupKey(item));
    const missing = isMissing(item, tree);
    const target = item.type === 'file' ? bookmarkTarget(item, tree) : null;
    const active = !group && target !== null && target === activePath && !subpathTarget(item);
    const label = bookmarkLabel(item);
    const detail = item.type === 'file' ? (subpathTarget(item) && !item.title ? displayName(item.path ?? '') : target ? folderOf(target) : '') : '';
    return (
      <div
        key={key}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={group ? open : undefined}
        aria-current={active ? 'page' : undefined}
        tabIndex={0}
        className={`tree-row bookmark-row${group ? ' tree-row-folder' : ''}${active ? ' is-active' : ''}${missing ? ' is-missing' : ''}${dropKey === key ? ' is-drop-target' : ''}`}
        style={{ paddingInlineStart: 8 + depth * 16 }}
        title={group ? label : describeBookmark(item, missing)}
        draggable={!coarse}
        onDragStart={(e) => {
          e.dataTransfer.setData(BOOKMARK_DRAG_TYPE, JSON.stringify(path));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => setDropKey(null)}
        onDragOver={(e) => onDragOver(e, row)}
        onDrop={(e) => onDrop(e, row)}
        onClick={(e) => {
          if (swallowClick()) return;
          activate(row, isKeyboardClick(e));
        }}
        onKeyDown={(e) => onKeyDown(e, row)}
        {...rowHandlers(row)}
      >
        {depth > 0 && <span className="tree-guides" aria-hidden style={{ width: depth * 16 }} />}
        <span className={`tree-chevron${group ? '' : ' is-empty'}${open ? ' is-open' : ''}`} aria-hidden>
          {group && <ChevronRight size={14} />}
        </span>
        {!group && <ItemIcon item={item} tree={tree} />}
        <span className="tree-name">{label}</span>
        {detail && <span className="bookmark-detail">{detail}</span>}
        {coarse && (
          <button
            type="button"
            className="icon-button tree-more"
            tabIndex={-1}
            aria-label={`Actions for ${label}`}
            title="More actions"
            onClick={(e) => {
              e.stopPropagation();
              openAt(row, e.currentTarget, true);
            }}
          >
            <Ellipsis size={18} />
          </button>
        )}
      </div>
    );
  };

  const groupKeys = rows.filter((r) => isGroup(r.item)).map((r) => groupKey(r.item));
  return (
    <div
      className="bookmarks"
      onDragOver={(e) => onDragOver(e, null)}
      onDrop={(e) => onDrop(e, null)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey(null);
      }}
    >
      <div className="panel-toolbar" role="toolbar" aria-label="Bookmarks">
        <button
          type="button"
          className="icon-button"
          aria-label={activeStarred ? 'Remove the bookmark for the current file' : 'Bookmark the current file'}
          title={activeStarred ? 'Remove the bookmark for the current file' : 'Bookmark the current file'}
          disabled={!activePath || !tree?.byPath.has(activePath)}
          onClick={() => activePath && void toggleFileBookmark(activePath)}
        >
          {activeStarred ? <BookmarkMinus size={16} /> : <BookmarkPlus size={16} />}
        </button>
        <button type="button" className="icon-button" aria-label="New group" title="New group" onClick={() => void promptNewGroup()}>
          <FolderPlus size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="Collapse all groups" title="Collapse all groups" disabled={groupKeys.length === 0} onClick={() => collapseAll(groupKeys)}>
          <ChevronsDownUp size={16} />
        </button>
      </div>
      {isPending ? (
        <div className="panel-empty">Loading…</div>
      ) : isError && items.length === 0 ? (
        <div className="panel-empty">Could not load bookmarks.</div>
      ) : rows.length === 0 ? (
        <div className={`panel-empty${dropKey === '' ? ' is-drop-target' : ''}`}>No bookmarks yet. Bookmark a note with the star in its header, from a file’s menu, or with the command palette.</div>
      ) : (
        <div className={`bookmark-list${dropKey === '' ? ' is-drop-target' : ''}`} role="tree" aria-label="Bookmarks">
          {rows.map(renderRow)}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${bookmarkLabel(menu.target.item)}`} items={menuItems(menu.target, items, tree)} onClose={close} />}
    </div>
  );
}
