// Explorer row menu items (DESIGN §6.15): new note/folder here and the views' create items,
// rename, move, delete, copy link, file history and download.
import { Copy, Download, FilePlus, FolderInput, FolderPlus, History, Pencil, Trash } from 'lucide-react';
import type { FileEntry } from '../../api/types';
import { copyLink, createFolder, createNote, deleteEntry, downloadFile, validateNewName } from '../../features/fileOps';
import { activePath, openPath } from '../../features/navigation';
import { displayName, folderOf } from '../../features/paths';
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
      run: () => createNote(folder, d.create!.initialContent(), d.create!.extension),
    }));
  const items: MenuEntry[] = [
    ...creates,
    { id: 'new-folder', label: 'New folder here', icon: <FolderPlus size={16} />, run: () => void promptNewFolder(folder) },
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil size={16} />, run: startRename },
    { id: 'move', label: 'Move to…', icon: <FolderInput size={16} />, run: () => useUi.getState().setMoveTarget({ path: row.path, type: row.kind }) },
  ];
  if (row.kind === 'file') {
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
