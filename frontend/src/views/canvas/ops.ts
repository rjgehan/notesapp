// Editing operations on canvas documents. Every function is pure: it returns a new document that
// shares every node and edge it did not change (by identity), which keeps untouched objects'
// original text on save (format.ts) and lets React skip re-rendering them.
import {
  boundsOf,
  idSet,
  newId,
  nodeRect,
  rectContains,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type Point,
  type Rect,
} from './model';

/** Sets fields on an object, deleting those set to undefined; returns the same object when nothing changes. */
export function patchObject<T extends object>(obj: T, patch: Partial<Record<string, unknown>>): T {
  let changed = false;
  const next: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      if (k in next) {
        delete next[k];
        changed = true;
      }
    } else if (next[k] !== v) {
      next[k] = v;
      changed = true;
    }
  }
  return changed ? (next as T) : obj;
}

function withNodes(doc: CanvasDoc, nodes: readonly CanvasNode[]): CanvasDoc {
  return nodes === doc.nodes ? doc : { ...doc, nodes };
}

function withEdges(doc: CanvasDoc, edges: readonly CanvasEdge[]): CanvasDoc {
  return edges === doc.edges ? doc : { ...doc, edges };
}

function mapNodes(doc: CanvasDoc, fn: (n: CanvasNode) => CanvasNode): CanvasDoc {
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    const m = fn(n);
    if (m !== n) changed = true;
    return m;
  });
  return changed ? withNodes(doc, nodes) : doc;
}

export function updateNode(doc: CanvasDoc, id: string, patch: Partial<Record<string, unknown>>): CanvasDoc {
  return mapNodes(doc, (n) => (n.id === id ? patchObject(n, patch) : n));
}

/**
 * File nodes (and group backgrounds) whose file moved: `where(path)` gives the new path, or null.
 * Returns the same document when nothing points at a moved file.
 */
export function followMoves(doc: CanvasDoc, where: (path: string) => string | null): CanvasDoc {
  return mapNodes(doc, (n) => {
    if (n.type === 'file' && typeof n.file === 'string') {
      const to = where(n.file);
      return to && to !== n.file ? patchObject(n, { file: to }) : n;
    }
    if (n.type === 'group' && typeof n.background === 'string') {
      const to = where(n.background);
      return to && to !== n.background ? patchObject(n, { background: to }) : n;
    }
    return n;
  });
}

/** Replaces a node with another object (keeping its place in the stacking order). */
export function replaceNode(doc: CanvasDoc, id: string, node: CanvasNode): CanvasDoc {
  return mapNodes(doc, (n) => (n.id === id ? node : n));
}

export function updateNodes(doc: CanvasDoc, ids: ReadonlySet<string>, patch: Partial<Record<string, unknown>>): CanvasDoc {
  return mapNodes(doc, (n) => (ids.has(n.id) ? patchObject(n, patch) : n));
}

export function updateEdge(doc: CanvasDoc, id: string, patch: Partial<Record<string, unknown>>): CanvasDoc {
  let changed = false;
  const edges = doc.edges.map((e) => {
    if (e.id !== id) return e;
    const next = patchObject(e, patch);
    if (next !== e) changed = true;
    return next;
  });
  return changed ? withEdges(doc, edges) : doc;
}

export function updateEdges(doc: CanvasDoc, ids: ReadonlySet<string>, patch: Partial<Record<string, unknown>>): CanvasDoc {
  let changed = false;
  const edges = doc.edges.map((e) => {
    if (!ids.has(e.id)) return e;
    const next = patchObject(e, patch);
    if (next !== e) changed = true;
    return next;
  });
  return changed ? withEdges(doc, edges) : doc;
}

/** Appends nodes on top of the others (the last node is drawn on top). */
export function addNodes(doc: CanvasDoc, nodes: readonly CanvasNode[]): CanvasDoc {
  return nodes.length === 0 ? doc : withNodes(doc, [...doc.nodes, ...nodes]);
}

export function addEdges(doc: CanvasDoc, edges: readonly CanvasEdge[]): CanvasDoc {
  return edges.length === 0 ? doc : withEdges(doc, [...doc.edges, ...edges]);
}

/** Removes nodes (with the edges attached to them) and edges. */
export function deleteItems(doc: CanvasDoc, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): CanvasDoc {
  const nodes = nodeIds.size ? doc.nodes.filter((n) => !nodeIds.has(n.id)) : doc.nodes;
  const edges = doc.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode));
  return withEdges(withNodes(doc, nodes.length === doc.nodes.length ? doc.nodes : nodes), edges.length === doc.edges.length ? doc.edges : edges);
}

/**
 * The nodes that move with `ids`: groups carry the nodes lying entirely inside them (as in
 * Obsidian), recursively.
 */
export function withGroupContents(doc: CanvasDoc, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  const queue = doc.nodes.filter((n) => ids.has(n.id) && n.type === 'group');
  while (queue.length > 0) {
    const group = queue.pop()!;
    const area = nodeRect(group);
    for (const n of doc.nodes) {
      if (out.has(n.id) || !rectContains(area, nodeRect(n))) continue;
      out.add(n.id);
      if (n.type === 'group') queue.push(n);
    }
  }
  return out;
}

export function snap(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : Math.round(v);
}

/** Moves nodes by (dx, dy), rounding positions to whole pixels (the spec's integers). */
export function moveNodes(doc: CanvasDoc, ids: ReadonlySet<string>, dx: number, dy: number): CanvasDoc {
  if (dx === 0 && dy === 0) return doc;
  return mapNodes(doc, (n) => {
    if (!ids.has(n.id)) return n;
    const r = nodeRect(n);
    return patchObject(n, { x: Math.round(r.x + dx), y: Math.round(r.y + dy) });
  });
}

export function setNodeRect(doc: CanvasDoc, id: string, rect: Rect): CanvasDoc {
  return updateNode(doc, id, { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
}

/** Moves nodes to the top (end of the list) or the bottom (start), keeping their relative order. */
export function reorder(doc: CanvasDoc, ids: ReadonlySet<string>, where: 'front' | 'back'): CanvasDoc {
  const picked = doc.nodes.filter((n) => ids.has(n.id));
  if (picked.length === 0) return doc;
  const rest = doc.nodes.filter((n) => !ids.has(n.id));
  const nodes = where === 'front' ? [...rest, ...picked] : [...picked, ...rest];
  return nodes.every((n, i) => n === doc.nodes[i]) ? doc : withNodes(doc, nodes);
}

export const GROUP_PADDING = 40;

/**
 * Wraps nodes in a new group sized to their bounds plus padding, placed beneath the lowest of
 * them so it never covers them. Returns the document and the group's id.
 */
export function groupNodes(doc: CanvasDoc, ids: ReadonlySet<string>, label = 'Group'): { doc: CanvasDoc; id: string } | null {
  const members = doc.nodes.filter((n) => ids.has(n.id));
  const b = boundsOf(members.map(nodeRect));
  if (!b) return null;
  const id = newId(idSet(doc));
  const group: CanvasNode = {
    id,
    type: 'group',
    x: Math.round(b.x - GROUP_PADDING),
    y: Math.round(b.y - GROUP_PADDING),
    width: Math.round(b.width + 2 * GROUP_PADDING),
    height: Math.round(b.height + 2 * GROUP_PADDING),
    label,
  };
  const first = doc.nodes.findIndex((n) => ids.has(n.id));
  const nodes = [...doc.nodes.slice(0, first), group, ...doc.nodes.slice(first)];
  return { doc: withNodes(doc, nodes), id };
}

// ---------- copy and paste ----------

/** A piece of canvas on the clipboard: JSON Canvas itself, so it pastes into Obsidian too. */
export interface CanvasFragment {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** The selected nodes (with what their groups contain) and the edges between them. */
export function copyFragment(doc: CanvasDoc, nodeIds: ReadonlySet<string>): CanvasFragment {
  const ids = withGroupContents(doc, nodeIds);
  const nodes = doc.nodes.filter((n) => ids.has(n.id));
  const edges = doc.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
  return { nodes, edges };
}

/** Reads a clipboard text as a canvas fragment, or null. */
export function parseFragment(text: string): CanvasFragment | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const data = JSON.parse(t) as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) return null;
    const nodes = data.nodes.filter(
      (n): n is CanvasNode => typeof n === 'object' && n !== null && typeof (n as CanvasNode).type === 'string',
    );
    const edges = (Array.isArray(data.edges) ? data.edges : []).filter(
      (e): e is CanvasEdge => typeof e === 'object' && e !== null && typeof (e as CanvasEdge).fromNode === 'string' && typeof (e as CanvasEdge).toNode === 'string',
    );
    return nodes.length ? { nodes, edges } : null;
  } catch {
    return null;
  }
}

/**
 * Adds a fragment with fresh ids, its top-left corner at `at`. Returns the document and the new
 * node ids. Edges whose ends are not in the fragment are dropped.
 */
export function pasteFragment(doc: CanvasDoc, fragment: CanvasFragment, at: Point): { doc: CanvasDoc; ids: string[] } {
  const taken = idSet(doc);
  const b = boundsOf(fragment.nodes.map(nodeRect)) ?? { x: 0, y: 0, width: 0, height: 0 };
  const dx = Math.round(at.x - b.x);
  const dy = Math.round(at.y - b.y);
  const remap = new Map<string, string>();
  const nodes = fragment.nodes.map((n) => {
    const id = newId(taken);
    taken.add(id);
    if (typeof n.id === 'string') remap.set(n.id, id);
    const r = nodeRect(n);
    return { ...n, id, x: Math.round(r.x + dx), y: Math.round(r.y + dy), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const edges: CanvasEdge[] = [];
  for (const e of fragment.edges) {
    const from = remap.get(e.fromNode);
    const to = remap.get(e.toNode);
    if (!from || !to) continue;
    const id = newId(taken);
    taken.add(id);
    edges.push({ ...e, id, fromNode: from, toNode: to });
  }
  // Groups go beneath everything pasted with them.
  const ordered = [...nodes.filter((n) => n.type === 'group'), ...nodes.filter((n) => n.type !== 'group')];
  return { doc: addEdges(addNodes(doc, ordered), edges), ids: nodes.map((n) => n.id) };
}

// ---------- creating nodes ----------

export const DEFAULT_SIZES: Record<string, { width: number; height: number }> = {
  text: { width: 250, height: 60 },
  file: { width: 400, height: 400 },
  image: { width: 400, height: 300 },
  link: { width: 400, height: 120 },
  group: { width: 400, height: 300 },
};

/** A new node centred on `at` (fields in Obsidian's order). */
export function makeNode(doc: CanvasDoc, kind: 'text' | 'file' | 'link' | 'group', at: Point, fields: Partial<CanvasNode> = {}, size?: { width: number; height: number }): CanvasNode {
  const s = size ?? DEFAULT_SIZES[kind];
  const id = newId(idSet(doc));
  // On the 20 px grid that moves snap to, so new cards line up with the others.
  const geometry = { x: snap(at.x - s.width / 2, 20), y: snap(at.y - s.height / 2, 20), width: Math.round(s.width), height: Math.round(s.height) };
  // Obsidian writes a group's label after its geometry, and other nodes' content before it.
  return kind === 'group' ? { id, type: kind, ...geometry, ...fields } : { id, type: kind, ...fields, ...geometry };
}
