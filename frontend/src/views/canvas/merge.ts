// Node-level 3-way merge of two versions of a canvas (ROADMAP item 25, DESIGN §6.8 `merge()`):
// edits made on two devices to different nodes, or to different fields of one node, combine; the
// merge fails (and the conflict banner shows) only when both changed the same content (a card's
// text, a label, a file or URL) differently, or the files cannot be read.
//
// - A node or edge added on either side is kept; one deleted on one side and untouched on the
//   other is deleted; one deleted on one side but edited on the other is kept with the edit.
// - Fields merge one by one. When both sides moved, resized or recoloured the same node, this
//   device's choice wins: it is what the user here last saw and did.
// - Stacking order follows the side that changed it (this device when both did); nodes new on the
//   other side go in after their neighbour there.
// - Edges left without one of their nodes by the merge are dropped.
import { parseCanvas, serializeCanvas } from './format';
import type { CanvasDoc } from './model';

/** Fields whose conflicting edits the merge refuses to choose between. */
const CONTENT_FIELDS = new Set(['type', 'text', 'file', 'subpath', 'url', 'label', 'background', 'fromNode', 'toNode']);

const CONFLICT = Symbol('conflict');

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const bo = b as Record<string, unknown>;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual((a as Record<string, unknown>)[k], bo[k]));
}

/** The merged value; on a conflict, CONFLICT when `strict`, otherwise mine. */
function mergeValue(base: unknown, mine: unknown, theirs: unknown, strict: boolean): unknown {
  if (deepEqual(mine, base)) return theirs;
  if (deepEqual(theirs, base)) return mine;
  if (deepEqual(mine, theirs)) return mine;
  return strict ? CONFLICT : mine;
}

/** Field-by-field merge of one object (mine's key order, then keys only theirs has). */
function mergeFields<T extends object>(base: T | undefined, mine: T, theirs: T): T | null {
  const b = (base ?? {}) as Record<string, unknown>;
  const m = mine as Record<string, unknown>;
  const t = theirs as Record<string, unknown>;
  const keys = [...Object.keys(m), ...Object.keys(t).filter((k) => !(k in m)), ...Object.keys(b).filter((k) => !(k in m) && !(k in t))];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = mergeValue(b[k], m[k], t[k], CONTENT_FIELDS.has(k));
    if (v === CONFLICT) return null;
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

/** True when the ids both lists share appear in the same relative order. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  const inB = new Set(b);
  const inA = new Set(a);
  const fa = a.filter((id) => inB.has(id));
  const fb = b.filter((id) => inA.has(id));
  return fa.length === fb.length && fa.every((id, i) => id === fb[i]);
}

function mergeOrder(base: string[], mine: string[], theirs: string[], keep: Set<string>): string[] {
  const mineMoved = !sameOrder(mine, base);
  const theirsMoved = !sameOrder(theirs, base);
  const [primary, secondary] = theirsMoved && !mineMoved ? [theirs, mine] : [mine, theirs];
  const order = primary.filter((id) => keep.has(id));
  const placed = new Set(order);
  secondary.forEach((id, i) => {
    if (!keep.has(id) || placed.has(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(secondary[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    order.splice(at, 0, id);
    placed.add(id);
  });
  return order;
}

function mergeList<T extends { id: string }>(base: readonly T[], mine: readonly T[], theirs: readonly T[]): T[] | null {
  const b = byId(base);
  const m = byId(mine);
  const t = byId(theirs);
  const result = new Map<string, T>();
  for (const id of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const bi = b.get(id);
    const mi = m.get(id);
    const ti = t.get(id);
    if (!mi && !ti) continue;
    if (!mi || !ti) {
      const present = (mi ?? ti)!;
      // Deleted on one side: gone unless the other side changed it meanwhile (or added it).
      if (bi && deepEqual(present, bi)) continue;
      result.set(id, present);
      continue;
    }
    if (deepEqual(mi, ti) || (bi && deepEqual(ti, bi))) result.set(id, mi);
    else if (bi && deepEqual(mi, bi)) result.set(id, ti);
    else {
      const merged = mergeFields(bi, mi, ti);
      if (!merged) return null;
      result.set(id, merged);
    }
  }
  const order = mergeOrder(
    base.map((i) => i.id),
    mine.map((i) => i.id),
    theirs.map((i) => i.id),
    new Set(result.keys()),
  );
  return order.map((id) => result.get(id)!);
}

function mergeExtra(base: CanvasDoc['extra'], mine: CanvasDoc['extra'], theirs: CanvasDoc['extra']): Map<string, unknown> | null {
  const out = new Map<string, unknown>();
  for (const k of new Set([...mine.keys(), ...theirs.keys(), ...base.keys()])) {
    // Unknown top-level data is never chosen between.
    const v = mergeValue(base.get(k), mine.get(k), theirs.get(k), true);
    if (v === CONFLICT) return null;
    if (v !== undefined) out.set(k, v);
  }
  return out;
}

/** Merges two canvases changed from `base`; null when they cannot be combined automatically. */
export function mergeCanvas(baseText: string, mineText: string, theirsText: string): string | null {
  if (mineText === theirsText || theirsText === baseText) return mineText;
  if (mineText === baseText) return theirsText;
  let base: CanvasDoc;
  let mine: CanvasDoc;
  let theirs: CanvasDoc;
  try {
    base = parseCanvas(baseText);
    mine = parseCanvas(mineText);
    theirs = parseCanvas(theirsText);
  } catch {
    return null;
  }
  const nodes = mergeList(base.nodes, mine.nodes, theirs.nodes);
  const edges = mergeList(base.edges, mine.edges, theirs.edges);
  const extra = mergeExtra(base.extra, mine.extra, theirs.extra);
  if (!nodes || !edges || !extra) return null;
  const present = new Set(nodes.map((n) => n.id));
  const known = new Set([...base.nodes, ...mine.nodes, ...theirs.nodes].map((n) => n.id));
  // Edges whose node the merge removed go too; edges that dangled in the files already stay.
  const kept = edges.filter((e) => (present.has(e.fromNode) || !known.has(e.fromNode)) && (present.has(e.toNode) || !known.has(e.toNode)));
  return serializeCanvas({ nodes, edges: kept, extra, format: mine.format, origin: null });
}
