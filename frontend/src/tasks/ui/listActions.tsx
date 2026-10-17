// List actions shared by the index page and a list page's header (API.md §20.5).
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, FileText, Pencil, Trash2 } from 'lucide-react';
import type { TaskList } from '../../api/types';
import type { MenuEntry } from '../../components/overlays/ContextMenu';
import { navigateTo, openPath } from '../../features/navigation';
import { promptText } from '../../state/dialogs';
import { createList, deleteList, moveList, updateList } from '../mutations';
import { listRoute } from './state';

const validName = (v: string) => (v.trim().length > 200 ? 'At most 200 characters' : /[\r\n]/.test(v) ? 'One line only' : null);

export async function promptNewList(): Promise<void> {
  const name = await promptText({ title: 'New list', label: 'Name', value: '', placeholder: 'Groceries', confirmLabel: 'Create', validate: validName });
  if (!name?.trim()) return;
  const list = await createList(name);
  if (list) navigateTo(listRoute(list.id));
}

export async function promptRenameList(list: TaskList): Promise<void> {
  const name = await promptText({ title: 'Rename list', label: 'Name', value: list.name, confirmLabel: 'Rename', validate: validName });
  if (!name?.trim() || name.trim() === list.name) return;
  await updateList(list, { name: name.trim() });
}

/** The menu of a list: on the index page and in a list page's header. */
export function listMenu(list: TaskList, neighbours?: { before: TaskList | null; beforeBefore: TaskList | null; after: TaskList | null }): MenuEntry[] {
  const writable = list.writable;
  const items: MenuEntry[] = [
    { id: 'rename', label: 'Rename…', icon: <Pencil size={16} />, disabled: !writable, run: () => void promptRenameList(list) },
  ];
  if (neighbours) {
    items.push(
      { id: 'up', label: 'Move up', icon: <ArrowUp size={16} />, disabled: !neighbours.before, run: () => void moveList(list, neighbours.beforeBefore?.id ?? null) },
      { id: 'down', label: 'Move down', icon: <ArrowDown size={16} />, disabled: !neighbours.after, run: () => neighbours.after && void moveList(list, neighbours.after.id) },
    );
  }
  items.push(
    list.archived
      ? { id: 'unarchive', label: 'Unarchive', icon: <ArchiveRestore size={16} />, disabled: !writable, run: () => void updateList(list, { archived: false }) }
      : { id: 'archive', label: 'Archive', icon: <Archive size={16} />, disabled: !writable, run: () => void updateList(list, { archived: true }) },
    { id: 'file', label: 'Open list file', icon: <FileText size={16} />, run: () => openPath(list.path) },
    'separator',
    { id: 'delete', label: 'Delete list…', icon: <Trash2 size={16} />, danger: true, run: () => void deleteList(list) },
  );
  return items;
}

