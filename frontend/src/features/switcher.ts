// Quick switcher items and ranking (DESIGN §6.13).
import type { FileEntry } from '../api/types';
import type { VaultTree } from '../api/vaultTree';
import { fuzzyRank } from './fuzzy';
import { folderOf, stripMd } from './paths';

export interface SwitcherItem {
  kind: 'note' | 'alias' | 'file' | 'create' | 'search';
  key: string;
  label: string;
  detail: string;
  path: string;
  entry?: FileEntry;
}

const LIMIT = 50;
const RECENT = 20;
/** Notes (and their aliases) outrank other files with the same match quality. */
const NOTE_BOOST = 0.05;

function baseItems(tree: VaultTree): SwitcherItem[] {
  const items: SwitcherItem[] = [];
  for (const entry of tree.files) {
    const note = entry.kind === 'note';
    items.push({ kind: note ? 'note' : 'file', key: entry.path, label: note ? entry.basename : entry.name, detail: folderOf(entry.path), path: entry.path, entry });
  }
  for (const { alias, entry } of tree.aliasItems) {
    items.push({ kind: 'alias', key: `alias:${entry.path}:${alias}`, label: alias, detail: `alias of ${entry.basename}`, path: entry.path, entry });
  }
  return items;
}

/**
 * The switcher's rows: the 20 most recent files for an empty query; otherwise the fuzzy ranking
 * over label and path, then a Create row when no item matches the query exactly, then (phones) a
 * "Search in notes" row.
 */
export function switcherItems(tree: VaultTree, query: string, recent: readonly string[], withSearchRow = false): SwitcherItem[] {
  const q = query.trim();
  const all = baseItems(tree);
  let rows: SwitcherItem[];
  if (q === '') {
    const byPath = new Map(all.filter((i) => i.kind !== 'alias').map((i) => [i.path, i]));
    rows = recent
      .map((p) => byPath.get(p))
      .filter((i): i is SwitcherItem => !!i)
      .slice(0, RECENT);
  } else {
    rows = fuzzyRank(q, all, [(i) => i.label, (i) => i.path], LIMIT, (i) => (i.kind === 'file' ? 0 : NOTE_BOOST)).map((r) => r.item);
    const lower = q.toLowerCase();
    const exact = all.some((i) => i.label.toLowerCase() === lower || stripMd(i.path).toLowerCase() === lower || i.path.toLowerCase() === lower);
    if (!exact) rows.push({ kind: 'create', key: 'create', label: `Create “${q}”`, detail: '', path: q });
  }
  if (withSearchRow && q !== '') rows.push({ kind: 'search', key: 'search', label: `Search in notes for “${q}”`, detail: '', path: q });
  return rows;
}
