// What the Bookmarks pane shows and does for a row (DESIGN §6.23), apart from the component.
import type { BookmarkItem } from '../../api/types';
import { findFileIgnoreCase, type VaultTree } from '../../api/vaultTree';
import { bookmarkLabel, insertAt, isGroup, itemAt, removeAt, subpathTarget, updateAt, type ItemPath, type PlacedItem } from '../../features/bookmarks';
import { editBookmarks } from '../../features/bookmarkStore';
import { afterOpen } from '../../features/focus';
import { openPath, openSearch } from '../../features/navigation';
import { promptText } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import { showPanel } from '../layout/showPanel';

/** A group's key for its collapsed state: groups have no id, so creation time and title. */
export function groupKey(item: BookmarkItem): string {
  return `${item.ctime ?? 0}:${item.title ?? ''}`;
}

/** The rows to show: groups' contents only while the group is expanded. */
export function visibleRows(items: readonly BookmarkItem[], collapsed: ReadonlySet<string>): PlacedItem[] {
  const out: PlacedItem[] = [];
  const visit = (list: readonly BookmarkItem[], base: ItemPath, depth: number) =>
    list.forEach((item, i) => {
      const path = [...base, i];
      out.push({ item, path, depth });
      if (isGroup(item) && Array.isArray(item.items) && !collapsed.has(groupKey(item))) visit(item.items, path, depth + 1);
    });
  visit(items, [], 0);
  return out;
}

/** The real path of a file or folder bookmark (case-insensitive, as links resolve), or null when it is missing. */
export function bookmarkTarget(item: BookmarkItem, tree: VaultTree | undefined): string | null {
  if (!tree || typeof item.path !== 'string') return null;
  if (item.type === 'file') return findFileIgnoreCase(tree, item.path)?.path ?? null;
  if (item.type === 'folder') return tree.folderPaths.has(item.path) ? item.path : (tree.byLowerFolder.get(item.path.toLowerCase()) ?? null);
  return null;
}

/** A file or folder bookmark whose target is not in the vault (deleted, or moved outside the app). */
export function isMissing(item: BookmarkItem, tree: VaultTree | undefined): boolean {
  return !!tree && (item.type === 'file' || item.type === 'folder') && bookmarkTarget(item, tree) === null;
}

/** The row's tooltip: where it points. */
export function describeBookmark(item: BookmarkItem, missing: boolean): string {
  const where =
    item.type === 'file' || item.type === 'folder'
      ? (item.path ?? '') + (typeof item.subpath === 'string' ? item.subpath : '')
      : item.type === 'search'
        ? `Search: ${item.query ?? ''}`
        : typeof item.url === 'string'
          ? item.url
          : '';
  return missing ? `${where} (not found: deleted, or moved outside NotesApp)` : where;
}

function missingToast(item: BookmarkItem, path: ItemPath): void {
  toast(`“${bookmarkLabel(item)}” is not in the vault: it was deleted, or moved outside NotesApp`, {
    action: { label: 'Remove bookmark', run: () => void editBookmarks((items) => (itemAt(items, path)?.ctime === item.ctime ? removeAt(items, path) : items)) },
  });
}

/** Opens a bookmark's target: a file (at its heading), a folder in the explorer, a search. */
export function openBookmark(item: BookmarkItem, tree: VaultTree | undefined, path: ItemPath, viaKeyboard = false): void {
  switch (item.type) {
    case 'file': {
      const target = bookmarkTarget(item, tree);
      if (!target) {
        missingToast(item, path);
        return;
      }
      afterOpen(target, viaKeyboard);
      openPath(target, subpathTarget(item));
      return;
    }
    case 'folder': {
      const target = bookmarkTarget(item, tree);
      if (!target) {
        missingToast(item, path);
        return;
      }
      showPanel('left', 'files');
      useUi.getState().setExpanded(target, true);
      useUi.getState().revealInExplorer(target);
      return;
    }
    case 'search':
      if (typeof item.query === 'string') openSearch(item.query);
      return;
    case 'url':
      if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    default:
      toast(`“${bookmarkLabel(item)}” bookmarks are not supported in NotesApp`);
  }
}

/** Asks for a display name; an empty one (or the target's own name) removes a bookmark's title. */
export async function renameBookmark(item: BookmarkItem, path: ItemPath): Promise<void> {
  const group = isGroup(item);
  const value = await promptText({
    title: group ? 'Rename group' : 'Rename bookmark',
    label: group ? 'Name' : 'Name shown in Bookmarks (empty: the target’s own name)',
    value: typeof item.title === 'string' ? item.title : group ? '' : bookmarkLabel(item),
    confirmLabel: 'Rename',
    validate: (v) => (group && v.trim() === '' ? 'A group needs a name' : null),
  });
  if (value === null) return;
  const title = value.trim();
  await editBookmarks((items) =>
    updateAt(items, path, (current) => {
      if (current.ctime !== item.ctime || current.type !== item.type) return current;
      const next: BookmarkItem = { ...current };
      if (title === '' || (!group && title === bookmarkLabel({ ...current, title: undefined }))) delete next.title;
      else next.title = title;
      return next;
    }),
  );
}

/** Removes a group; its bookmarks take its place. */
export function removeGroup(path: ItemPath): Promise<void> {
  return editBookmarks((items) => {
    const group = itemAt(items, path);
    if (!group || !isGroup(group)) return items;
    let next = removeAt(items, path);
    const children = Array.isArray(group.items) ? group.items : [];
    children.forEach((child, i) => {
      next = insertAt(next, path.slice(0, -1), child, path[path.length - 1] + i);
    });
    return next;
  });
}

/** Where a drop on a row puts the dragged item: into a group, otherwise before the row. */
export function dropPlace(row: PlacedItem | null): { parent: ItemPath; index: number } {
  if (!row) return { parent: [], index: Number.MAX_SAFE_INTEGER };
  if (isGroup(row.item)) return { parent: row.path, index: Number.MAX_SAFE_INTEGER };
  return { parent: row.path.slice(0, -1), index: row.path[row.path.length - 1] };
}
