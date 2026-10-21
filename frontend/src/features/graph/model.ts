// The graph view's data model (ROADMAP item 16, DESIGN §6.21): the server's compact graph
// (API.md §11.4) turned into nodes with stable ids, then filtered into what one view shows: the
// global graph or the local graph of a note, with tags as nodes, attachments, unresolved links and
// orphans as Obsidian offers them.
import type { GraphResponse } from '../../api/types';
import { compileQuery, isActiveQuery, type QueryNode } from './query';
import type { ColorGroup, FilterOptions } from './options';

export type NodeType = 'note' | 'attachment' | 'unresolved' | 'tag';

export interface GraphNodeModel extends QueryNode {
  /** Stable across refreshes: the path, '?' + lower(target) for unresolved links, '#' + lower(tag) for tags. */
  id: string;
}

export interface BaseGraph {
  version: string;
  nodes: GraphNodeModel[];
  /** Flat triples [source, target, count] of node indexes, as the server sent them. */
  edges: Int32Array;
  byId: Map<string, number>;
}

export interface ViewNode extends GraphNodeModel {
  degree: number;
}

export interface ViewGraph {
  nodes: ViewNode[];
  /** Flat triples [a, b, dir]: dir 1 = a links to b, 2 = b links to a, 3 = both. One entry per pair. */
  links: Int32Array;
  /** Index of the local graph's note, or -1. */
  center: number;
}

export interface LocalScope {
  path: string;
  depth: number;
  incoming: boolean;
  outgoing: boolean;
  neighborLinks: boolean;
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /\.md$/i.test(name) ? name.slice(0, -3) : name;
}

function within(path: string, folder: string): boolean {
  return folder === '' || path.toLowerCase().startsWith(folder.toLowerCase() + '/');
}

/** The server's graph as nodes with ids, labels and (from the tree) aliases. */
export function baseGraph(res: GraphResponse, aliasesOf: (path: string) => readonly string[] = () => []): BaseGraph {
  const byId = new Map<string, number>();
  const nodes = res.nodes.map((n, i) => {
    const id = n.type === 'unresolved' ? '?' + n.path.toLowerCase() : n.path;
    byId.set(id, i);
    return {
      id,
      path: n.path,
      label: n.type === 'attachment' ? n.path.slice(n.path.lastIndexOf('/') + 1) : n.type === 'note' ? basename(n.path) : n.path,
      type: n.type,
      tags: n.tags,
      aliases: n.type === 'note' ? aliasesOf(n.path) : [],
    } satisfies GraphNodeModel;
  });
  return { version: res.version, nodes, edges: Int32Array.from(res.edges), byId };
}

/** Every distinct tag of the graph's notes, sorted case-insensitively (for the tag filter). */
export function graphTags(base: BaseGraph): string[] {
  const seen = new Map<string, string>();
  for (const n of base.nodes) for (const t of n.tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * The nodes and links one view shows.
 *
 * - Notes are filtered by folder, tag and search. With a folder or tag filter, attachments and
 *   unresolved links appear only next to a shown note; the search filter applies to every node.
 * - Attachments appear with `showAttachments`, unresolved links unless `hideUnresolved`, tags as
 *   nodes (linked to their notes) with `showTags`.
 * - Orphans (no link left after filtering) are hidden unless `showOrphans`.
 * - With `local`, only nodes up to `depth` links away from the note remain, walking the links
 *   allowed by `incoming` / `outgoing` (tags both ways); without `neighborLinks`, a link between
 *   two nodes at the same distance from the note is left out. The note itself always stays.
 */
export function buildView(base: BaseGraph, o: FilterOptions, local?: LocalScope): ViewGraph {
  const n = base.nodes.length;
  const centerBase = local ? (base.byId.get(local.path) ?? -1) : -1;
  if (local && centerBase < 0) return { nodes: [], links: new Int32Array(0), center: -1 };
  const search = isActiveQuery(o.search) ? compileQuery(o.search) : null;
  const tagQuery = o.tag ? compileQuery(`tag:"${o.tag}"`) : null;
  const scoped = o.folder !== '' || tagQuery !== null;

  // 1. Which base nodes may show.
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const node = base.nodes[i]!;
    if (node.type === 'attachment' && !o.showAttachments) continue;
    if (node.type === 'unresolved' && o.hideUnresolved) continue;
    if (search && !search(node) && i !== centerBase) continue;
    if (node.type === 'note' && i !== centerBase) {
      if (!within(node.path, o.folder)) continue;
      if (tagQuery && !tagQuery(node)) continue;
    }
    keep[i] = 1;
  }
  if (scoped) {
    // Attachments and unresolved links stay only when a shown note links to them.
    const touched = new Uint8Array(n);
    const e = base.edges;
    for (let k = 0; k < e.length; k += 3) {
      const s = e[k]!;
      const t = e[k + 1]!;
      if (keep[s] && base.nodes[s]!.type === 'note') touched[t] = 1;
      if (keep[t] && base.nodes[t]!.type === 'note') touched[s] = 1;
    }
    for (let i = 0; i < n; i++) if (keep[i] && base.nodes[i]!.type !== 'note' && !touched[i] && i !== centerBase) keep[i] = 0;
  }

  // 2. The candidate nodes (base nodes, then tag nodes) and directed pairs.
  const nodes: GraphNodeModel[] = [];
  const index = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    index[i] = nodes.length;
    nodes.push(base.nodes[i]!);
  }
  const pairs = new Map<number, number>();
  const pairKey = (a: number, b: number) => (a < b ? a * 0x200000 + b : b * 0x200000 + a);
  const addPair = (s: number, t: number) => {
    if (s === t) return;
    const key = pairKey(s, t);
    const bit = s < t ? 1 : 2;
    pairs.set(key, (pairs.get(key) ?? 0) | bit);
  };
  const e = base.edges;
  for (let k = 0; k < e.length; k += 3) {
    const s = index[e[k]!]!;
    const t = index[e[k + 1]!]!;
    if (s >= 0 && t >= 0) addPair(s, t);
  }
  const tagNode = new Map<string, number>();
  if (o.showTags) {
    const count = nodes.length;
    for (let i = 0; i < count; i++) {
      const node = nodes[i]!;
      if (node.type !== 'note') continue;
      for (const tag of node.tags) {
        const id = '#' + tag.toLowerCase();
        let t = tagNode.get(id);
        if (t === undefined) {
          const tagModel: GraphNodeModel = { id, path: '', label: '#' + tag, type: 'tag', tags: [], aliases: [] };
          if (search && !search(tagModel)) continue;
          t = nodes.length;
          tagNode.set(id, t);
          nodes.push(tagModel);
        }
        addPair(i, t);
      }
    }
  }

  // 3. The local scope: breadth-first from the note.
  let alive: Uint8Array = new Uint8Array(nodes.length).fill(1);
  let center = -1;
  if (local) {
    center = index[centerBase]!;
    const adjacency: number[][] = nodes.map(() => []);
    for (const [key, dir] of pairs) {
      const a = Math.floor(key / 0x200000);
      const b = key % 0x200000;
      const tagLink = nodes[a]!.type === 'tag' || nodes[b]!.type === 'tag';
      // dir bit 1: a → b, bit 2: b → a. From a, b is an outgoing neighbour when a links to b.
      const aToB = (dir & 1) !== 0;
      const bToA = (dir & 2) !== 0;
      if (tagLink || (local.outgoing && aToB) || (local.incoming && bToA)) adjacency[a]!.push(b);
      if (tagLink || (local.outgoing && bToA) || (local.incoming && aToB)) adjacency[b]!.push(a);
    }
    const depth = new Int32Array(nodes.length).fill(-1);
    depth[center] = 0;
    let frontier = [center];
    for (let d = 1; d <= local.depth && frontier.length > 0; d++) {
      const next: number[] = [];
      for (const u of frontier) {
        for (const v of adjacency[u]!) {
          if (depth[v] === -1) {
            depth[v] = d;
            next.push(v);
          }
        }
      }
      frontier = next;
    }
    alive = new Uint8Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) if (depth[i]! >= 0) alive[i] = 1;
    if (!local.neighborLinks) {
      for (const [key] of pairs) {
        const a = Math.floor(key / 0x200000);
        const b = key % 0x200000;
        if (depth[a] === depth[b]) pairs.delete(key);
      }
    }
  }

  // 4. Degrees, orphans, and the final compaction.
  const degree = new Int32Array(nodes.length);
  for (const [key] of pairs) {
    const a = Math.floor(key / 0x200000);
    const b = key % 0x200000;
    if (alive[a] && alive[b]) {
      degree[a]!++;
      degree[b]!++;
    }
  }
  const finalIndex = new Int32Array(nodes.length).fill(-1);
  const out: ViewNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!alive[i]) continue;
    if (!o.showOrphans && degree[i] === 0 && i !== center) continue;
    finalIndex[i] = out.length;
    out.push({ ...nodes[i]!, degree: degree[i]! });
  }
  const links: number[] = [];
  for (const [key, dir] of pairs) {
    const a = finalIndex[Math.floor(key / 0x200000)]!;
    const b = finalIndex[key % 0x200000]!;
    if (a >= 0 && b >= 0) links.push(a, b, dir);
  }
  return { nodes: out, links: Int32Array.from(links), center: center >= 0 ? finalIndex[center]! : -1 };
}

/** For each node, the color of the first group whose query matches it (Obsidian's rule), or null. */
export function groupColors(nodes: readonly QueryNode[], groups: readonly ColorGroup[]): (string | null)[] {
  const compiled = groups.filter((g) => isActiveQuery(g.query)).map((g) => ({ match: compileQuery(g.query), color: g.color }));
  return nodes.map((node) => compiled.find((g) => g.match(node))?.color ?? null);
}

/** Neighbour lists of a view (CSR: offsets into a flat array), for hover highlighting. */
export interface Adjacency {
  offsets: Int32Array;
  targets: Int32Array;
}

export function adjacency(view: ViewGraph): Adjacency {
  const count = view.nodes.length;
  const offsets = new Int32Array(count + 1);
  const l = view.links;
  for (let k = 0; k < l.length; k += 3) {
    offsets[l[k]! + 1]!++;
    offsets[l[k + 1]! + 1]!++;
  }
  for (let i = 0; i < count; i++) offsets[i + 1]! += offsets[i]!;
  const fill = offsets.slice(0, count);
  const targets = new Int32Array(offsets[count]!);
  for (let k = 0; k < l.length; k += 3) {
    const a = l[k]!;
    const b = l[k + 1]!;
    targets[fill[a]!++] = b;
    targets[fill[b]!++] = a;
  }
  return { offsets, targets };
}

/** The folders that hold notes in the graph, sorted (for the folder filter). */
export function graphFolders(base: BaseGraph): string[] {
  const folders = new Set<string>();
  for (const node of base.nodes) {
    if (node.type !== 'note') continue;
    let p = node.path;
    for (let slash = p.lastIndexOf('/'); slash > 0; slash = p.lastIndexOf('/')) {
      p = p.slice(0, slash);
      if (folders.has(p)) break;
      folders.add(p);
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
