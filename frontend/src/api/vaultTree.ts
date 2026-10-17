// Derived lookup structures over the ['tree'] snapshot (DESIGN §6.3). Built once per snapshot
// object and shared by React (useTree's select) and non-React code (editor, sessions).
import { buildLinkIndex, type LinkIndex } from '../features/links';
import type { FileEntry, FolderEntry, TreeResponse } from './types';

export interface AliasItem {
  alias: string;
  entry: FileEntry;
}

export interface VaultTree {
  eventId: string;
  folders: FolderEntry[];
  files: FileEntry[];
  byPath: Map<string, FileEntry>;
  folderPaths: Set<string>;
  /** lower(folder path) → folder path. */
  byLowerFolder: Map<string, string>;
  links: LinkIndex;
  notes: FileEntry[];
  aliasItems: AliasItem[];
}

const cache = new WeakMap<TreeResponse, VaultTree>();

export function buildVaultTree(tree: TreeResponse): VaultTree {
  const hit = cache.get(tree);
  if (hit) return hit;
  const byPath = new Map<string, FileEntry>();
  const notes: FileEntry[] = [];
  const aliasItems: AliasItem[] = [];
  for (const f of tree.files) {
    byPath.set(f.path, f);
    if (f.kind === 'note') {
      notes.push(f);
      for (const alias of f.aliases) aliasItems.push({ alias, entry: f });
    }
  }
  const folderPaths = new Set<string>();
  const byLowerFolder = new Map<string, string>();
  for (const d of tree.folders) {
    folderPaths.add(d.path);
    byLowerFolder.set(d.path.toLowerCase(), d.path);
  }
  const built: VaultTree = {
    eventId: tree.eventId,
    folders: tree.folders,
    files: tree.files,
    byPath,
    folderPaths,
    byLowerFolder,
    links: buildLinkIndex(byPath.keys()),
    notes,
    aliasItems,
  };
  cache.set(tree, built);
  return built;
}

export const EMPTY_TREE: TreeResponse = { eventId: '', folders: [], files: [] };

/** Case-insensitive file lookup. */
export function findFileIgnoreCase(tree: VaultTree, path: string): FileEntry | undefined {
  const exact = tree.byPath.get(path);
  if (exact) return exact;
  const hits = tree.links.byLowerPath.get(path.toLowerCase());
  return hits && hits.length ? tree.byPath.get(hits[0]) : undefined;
}
