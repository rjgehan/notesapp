// Explorer row menu items (DESIGN §6.15): new note/folder here and the views' create items,
// rename, move, delete, copy link, file history and download.
import { Columns2, Copy, Download, FilePlus, PanelTop, FolderInput, FolderPlus, History, LayoutTemplate, Pencil, Star, StarOff, Trash } from 'lucide-react';
import type { FileEntry } from '../../api/types';
import { findFolderBookmarks } from '../../features/bookmarks';
import { currentBookmarks, isFileBookmarked, toggleFileBookmark, toggleFolderBookmark } from '../../features/bookmarkStore';
import { copyLink, createFolder, createNote, deleteEntry, downloadFile, validateNewName } from '../../features/fileOps';
import { newNoteFromTemplateIn } from '../../features/folderTemplates';
import { activePath, openPath } from '../../features/navigation';
import { displayName, folderOf, noteRoute } from '../../features/paths';
import { openInNewTab, splitPane, workspace } from '../../workspace/store';
import { confirmAction, promptText } from '../../state/dialogs';
import { useUi } from '../../state/ui';
import { registeredViews } from '../../views/registry';
import { showPanel } from '../layout/showPanel';
import type { MenuEntry } from '../overlays/ContextMenu';

export interface RowTarget {
  kind: 'folder' | 'file';
  path: string;
  entry?: FileEntry;
}

/** The folder new entries go into for a row: the folder itself, or a file's parent. */
export function rowFolder(row: RowTarget): string {
  return row.kind === 'folder' ? row.path : folderOf(row.path);
}

export async function promptNewFolder(parent: string): Promise<void> {
  const name = await promptText({
    title: 'New folder',
    label: parent ? `Name (in ${parent})` : 'Name',
    value: '',
    placeholder: 'Folder name',
    confirmLabel: 'Create',
    validate: (v) => (v.trim() === '' ? null : validateNewName(v.trim())),
  });
  if (name) await createFolder(parent, name);
}

export async function confirmDelete(path: string, kind: 'file' | 'folder'): Promise<void> {
  const ok = await confirmAction({
    title: kind === 'folder' ? 'Delete folder?' : 'Delete file?',
    message:
      kind === 'folder'
        ? `“${displayName(path)}” and everything in it will be moved to the trash.`
        : `“${displayName(path)}” will be moved to the trash.`,
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (ok) await deleteEntry(path, kind);
}

export function rowMenuItems(row: RowTarget, startRename: () => void): MenuEntry[] {
  const folder = rowFolder(row);
  const creates: MenuEntry[] = registeredViews()
    .filter((d) => d.create)
    .map((d) => ({
      id: `create:${d.id}`,
      label: `New ${d.create!.label} here`,
      icon: <FilePlus size={16} />,
      run: () => createNote(folder, d.create!.initialContent(), d.create!.extension, d.create!.label),
    }));
  const items: MenuEntry[] = [
    ...creates,
    { id: 'new-from-template', label: 'New note from template here', icon: <LayoutTemplate size={16} />, run: () => newNoteFromTemplateIn(folder) },
    { id: 'new-folder', label: 'New folder here', icon: <FolderPlus size={16} />, run: () => void promptNewFolder(folder) },
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil size={16} />, run: startRename },
    { id: 'move', label: 'Move to…', icon: <FolderInput size={16} />, run: () => useUi.getState().setMoveTarget({ path: row.path, type: row.kind }) },
  ];
  const starred = row.kind === 'file' ? isFileBookmarked(currentBookmarks(), row.path) : findFolderBookmarks(currentBookmarks(), row.path).length > 0;
  items.push({
    id: 'bookmark',
    label: starred ? 'Remove bookmark' : 'Bookmark',
    icon: starred ? <StarOff size={16} /> : <Star size={16} />,
    run: () => void (row.kind === 'file' ? toggleFileBookmark(row.path) : toggleFolderBookmark(row.path)),
  });
  if (row.kind === 'file') {
    // Tabs and split panes (ROADMAP item 11, DESIGN §6.38); phones have one pane.
    const desktop = typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 767px)').matches;
    items.push({ id: 'open-tab', label: 'Open in new tab', icon: <PanelTop size={16} />, run: () => openInNewTab(noteRoute(row.path)) });
    if (desktop) {
      items.push({
        id: 'open-right',
        label: 'Open to the right',
        icon: <Columns2 size={16} />,
        run: () => {
          splitPane(workspace().activePane, 'right');
          openPath(row.path, null, { replace: true });
        },
      });
    }
    items.push(
      { id: 'copy-link', label: 'Copy link', icon: <Copy size={16} />, run: () => void copyLink(row.path, activePath()) },
      {
        id: 'history',
        label: 'File history',
        icon: <History size={16} />,
        run: () => {
          openPath(row.path);
          showPanel('right', 'history');
        },
      },
    );
    if (row.entry) {
      const entry = row.entry;
      items.push({ id: 'download', label: 'Download', icon: <Download size={16} />, run: () => downloadFile(entry) });
    }
  }
  items.push('separator', { id: 'delete', label: 'Delete', icon: <Trash size={16} />, danger: true, run: () => void confirmDelete(row.path, row.kind) });
  return items;
}
