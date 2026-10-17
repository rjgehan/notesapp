// Flattened, sorted explorer rows from the ['tree'] snapshot (DESIGN §6.15).
import type { FileEntry } from '../../api/types';
import type { VaultTree } from '../../api/vaultTree';
import { displayName, folderOf, lastSegment } from '../../features/paths';
import type { ExplorerSort } from '../../state/ui';

export interface ExplorerRow {
  kind: 'folder' | 'file';
  path: string;
  name: string;
  depth: number;
  entry?: FileEntry;
  expanded?: boolean;
  /** The parent folder's row index, or -1 at the root. */
  parent: number;
  /** Position among siblings (1-based) and the sibling count, for aria-posinset/setsize. */
  pos: number;
  size: number;
}

interface FolderNode {
  folders: string[];
  files: FileEntry[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Children per folder path (`''` is the root). */
export function folderChildren(tree: VaultTree): Map<string, FolderNode> {
  const map = new Map<string, FolderNode>();
  const node = (path: string) => {
    let n = map.get(path);
    if (!n) map.set(path, (n = { folders: [], files: [] }));
    return n;
  };
  node('');
  for (const f of tree.folders) {
    node(f.path);
    node(folderOf(f.path)).folders.push(f.path);
  }
  for (const file of tree.files) node(folderOf(file.path)).files.push(file);
  return map;
}

export function flattenRows(children: Map<string, FolderNode>, expanded: Record<string, boolean>, sort: ExplorerSort): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const walk = (folder: string, depth: number, parent: number) => {
    const node = children.get(folder);
    if (!node) return;
    const folders = [...node.folders].sort((a, b) => collator.compare(lastSegment(a), lastSegment(b)));
    const files = [...node.files].sort((a, b) =>
      sort === 'mtime' ? Date.parse(b.mtime) - Date.parse(a.mtime) || collator.compare(a.name, b.name) : collator.compare(displayName(a.path), displayName(b.path)),
    );
    const size = folders.length + files.length;
    let pos = 0;
    for (const f of folders) {
      const isOpen = !!expanded[f];
      const index = rows.length;
      rows.push({ kind: 'folder', path: f, name: lastSegment(f), depth, expanded: isOpen, parent, pos: ++pos, size });
      if (isOpen) walk(f, depth + 1, index);
    }
    for (const file of files) {
      rows.push({ kind: 'file', path: file.path, name: displayName(file.path), depth, entry: file, parent, pos: ++pos, size });
    }
  };
  walk('', 0, -1);
  return rows;
}
