// The note's ⋯ menu (DESIGN §6.5, §6.6.1): "Show Markdown source", the escape hatch for when
// something has gone wrong in Live Preview, then the file's actions.
import { CodeXml, FolderInput, Pencil, Trash } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MenuEntry } from '../../components/overlays/ContextMenu';
import { getCommand, runCommand } from '../../features/commands';
import { toggleSourceMode } from '../../features/noteMode';
import type { ViewMode } from '../../state/ui';

/** The label of the source escape hatch: what choosing it does. */
export function sourceItemLabel(mode: ViewMode): string {
  return mode === 'source' ? 'Back to normal view' : 'Show Markdown source';
}

/** The note's ⋯ menu entries (desktop): the source escape hatch, then the file's actions. */
export function noteMenuItems(path: string, mode: ViewMode): MenuEntry[] {
  const file: MenuEntry[] = [];
  const command = (id: string, label: string, icon: ReactNode, danger = false) => {
    if (getCommand(id)) file.push({ id, label, icon, danger, run: () => runCommand(id, { activePath: path }) });
  };
  command('file.rename', 'Rename', <Pencil size={16} />);
  command('file.move', 'Move to…', <FolderInput size={16} />);
  command('file.delete', 'Delete', <Trash size={16} />, true);
  return [{ id: 'editor.toggleSource', label: sourceItemLabel(mode), icon: <CodeXml size={16} />, run: toggleSourceMode }, ...(file.length ? ['separator' as const, ...file] : [])];
}
