// The canvas editor's state outside React (ROADMAP item 25): the document, selection, viewport,
// the gesture in progress, undo and redo, and its binding to the file's DocumentSession.
//
// The session's text stays the source of truth for sync (DESIGN §6.8–6.10): every finished
// operation (a drop after a drag, a deletion, a typing pause) writes the serialized canvas into the
// session with `setText`, so autosave, drafts, conflicts, history and Take theirs work exactly as
// for notes. Canvas operations are discrete (a drag commits once, on release), so this costs one
// serialization per operation, not per pointer move. Any change of the session's text that this
// controller did not write itself (a remote update applied while clean, Take theirs, a restored
// draft, a merge) is adopted as the new document. A conflict whose base is known is merged node by
// node (merge.ts) and saved at once; the banner appears only when that merge fails.
import { toast } from '../../state/toasts';
import type { DocumentSession } from '../../sync/DocumentSession';
import { CanvasParseError, parseCanvas, serializeCanvas } from './format';
import { mergeCanvas } from './merge';
import {
  boundsOf,
  cssColor,
  idSet,
  newId,
  nodeRect,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
  type Point,
  type Rect,
} from './model';
import {
  addEdges,
  addNodes,
  copyFragment,
  deleteItems,
  followMoves,
  groupNodes,
  makeNode,
  moveNodes,
  pasteFragment,
  reorder,
  replaceNode,
  setNodeRect,
  updateEdge,
  updateEdges,
  updateNode,
  updateNodes,
  type CanvasFragment,
} from './ops';

export interface Viewport {
  /** Screen position of the world origin, in CSS pixels relative to the stage. */
  x: number;
  y: number;
  zoom: number;
}

export type Gesture =
  | { kind: 'move'; ids: ReadonlySet<string>; dx: number; dy: number }
  | { kind: 'resize'; id: string; rect: Rect }
  | { kind: 'connect'; from: string; side: CanvasSide; to: Point; target: string | null }
  | { kind: 'marquee'; rect: Rect };

export interface Selection {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

export interface CanvasState {
  /** null until the session has loaded, or when the text is not a canvas (see `error`). */
  doc: CanvasDoc | null;
  error: string | null;
  selection: Selection;
  view: Viewport;
  gesture: Gesture | null;
  /** The text card being edited inline. */
  editing: string | null;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
const UNDO_LIMIT = 200;
/** Typing is written to the session after this pause (and on blur, save, route change, pagehide). */
const TEXT_WRITE_DELAY_MS = 250;

const EMPTY_SELECTION: Selection = { nodes: new Set(), edges: new Set() };

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Where the clipboard of this page keeps its last canvas copy (the system clipboard may refuse reads). */
let pageClipboard: { text: string; fragment: CanvasFragment } | null = null;

export class CanvasController {
  private state: CanvasState;
  private readonly listeners = new Set<() => void>();
  private session: DocumentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The session text the current document corresponds to. */
  private syncedText: string | null = null;
  private lastChangeCount = -1;
  private undoStack: CanvasDoc[] = [];
  private redoStack: CanvasDoc[] = [];
  private mergeKey: string | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private mergeTried: string | null = null;
  private stage = { width: 800, height: 600 };
  private measured = false;
  private pasteCount = 0;

  constructor(view?: Viewport) {
    this.state = {
      doc: null,
      error: null,
      selection: EMPTY_SELECTION,
      view: view ?? { x: 0, y: 0, zoom: 1 },
      gesture: null,
      editing: null,
      canUndo: false,
      canRedo: false,
      readOnly: true,
    };
  }

  // ---------- observation ----------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): CanvasState => this.state;

  private set(patch: Partial<CanvasState>): void {
    this.state = { ...this.state, ...patch, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
    for (const fn of [...this.listeners]) fn();
  }

  get doc(): CanvasDoc | null {
    return this.state.doc;
  }

  get path(): string {
    return this.session?.path ?? '';
  }

  // ---------- the session ----------

  bind(session: DocumentSession): void {
    if (this.session === session) return;
    this.unbind();
    this.session = session;
    this.syncedText = null;
    this.lastChangeCount = -1;
    this.unsubscribe = session.subscribe(() => this.onSession());
    this.onSession();
  }

  unbind(): void {
    this.writeNow();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
  }

  private onSession(): void {
    const session = this.session;
    if (!session) return;
    const snap = session.getSnapshot();
    const readOnly = !snap.loaded || snap.status === 'readonly' || snap.status === 'loading' || snap.lossy;
    if (!snap.loaded) {
      if (readOnly !== this.state.readOnly) this.set({ readOnly });
      return;
    }
    const count = session.getChangeCount();
    if (count !== this.lastChangeCount || this.syncedText === null) {
      this.lastChangeCount = count;
      const text = session.getText();
      if (text !== this.syncedText) this.adopt(text);
    }
    if (readOnly !== this.state.readOnly) this.set({ readOnly });
    this.tryMerge();
  }

  /** The session's text changed under us (load, remote update, Take theirs, merge): it becomes the document. */
  private adopt(text: string): void {
    // Typing not yet written loses to the session's newer text; the session decides about conflicts.
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.syncedText = text;
    let doc: CanvasDoc;
    try {
      doc = parseCanvas(text);
    } catch (e) {
      this.undoStack = [];
      this.redoStack = [];
      this.set({ doc: null, error: e instanceof CanvasParseError ? e.message : String(e), editing: null, gesture: null, selection: EMPTY_SELECTION });
      return;
    }
    const first = this.state.doc === null;
    this.undoStack = [];
    this.redoStack = [];
    this.mergeKey = null;
    const ids = idSet(doc);
    const keep = (s: ReadonlySet<string>) => new Set([...s].filter((id) => ids.has(id)));
    this.set({
      doc,
      error: null,
      selection: first ? EMPTY_SELECTION : { nodes: keep(this.state.selection.nodes), edges: keep(this.state.selection.edges) },
      editing: this.state.editing && doc.nodes.some((n) => n.id === this.state.editing) ? this.state.editing : null,
      gesture: null,
    });
  }

  /** A conflict whose base is known merges node by node; the banner shows only if that fails. */
  private tryMerge(): void {
    const session = this.session;
    if (!session) return;
    const snap = session.getSnapshot();
    const c = snap.conflict;
    if (snap.status !== 'conflict' || !c || c.baseText === null || c.historyBlocked) return;
    this.writeNow();
    const mine = session.getText();
    const key = `${c.theirsVersion}\n${mine.length}\n${c.theirsText.length}`;
    if (key === this.mergeTried) return;
    this.mergeTried = key;
    const merged = mergeCanvas(c.baseText, mine, c.theirsText);
    if (merged === null) return;
    void session.saveMerged(merged).catch(() => undefined);
    toast('Merged changes from another device');
  }

  /** Writes pending typing into the session now (blur, save, route change, page hide). */
  writeNow(): void {
    if (!this.writeTimer) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.write();
  }

  private write(): void {
    const session = this.session;
    const doc = this.state.doc;
    if (!session || !doc) return;
    const text = serializeCanvas(doc);
    if (text === this.syncedText) return;
    this.syncedText = text;
    session.setText(text);
    this.lastChangeCount = session.getChangeCount();
  }

  /** Flushes the session (Mod-S inside a card). */
  save(): void {
    this.writeNow();
    void this.session?.flush();
  }

  // ---------- editing ----------

  /**
   * Replaces the document with `next` as one undoable step. Steps with the same `mergeKey` in a
   * row (typing in one card, nudges) undo together. `deferWrite` batches the session write.
   */
  commit(next: CanvasDoc, opts: { mergeKey?: string; deferWrite?: boolean; selection?: Selection; editing?: string | null } = {}): void {
    const prev = this.state.doc;
    if (!prev || this.state.readOnly) return;
    if (next !== prev) {
      if (!opts.mergeKey || opts.mergeKey !== this.mergeKey) {
        this.undoStack.push(prev);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.mergeKey = opts.mergeKey ?? null;
    this.set({
      doc: next,
      ...(opts.selection ? { selection: opts.selection } : {}),
      ...(opts.editing !== undefined ? { editing: opts.editing } : {}),
    });
    if (next === prev) return;
    if (opts.deferWrite) {
      if (this.writeTimer) clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.write();
      }, TEXT_WRITE_DELAY_MS);
    } else {
      if (this.writeTimer) clearTimeout(this.writeTimer);
      this.writeTimer = null;
      this.write();
    }
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev || !this.state.doc || this.state.readOnly) return;
    this.redoStack.push(this.state.doc);
    this.mergeKey = null;
    this.set({ doc: prev, editing: null, selection: this.pruned(prev) });
    this.write();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next || !this.state.doc || this.state.readOnly) return;
    this.undoStack.push(this.state.doc);
    this.mergeKey = null;
    this.set({ doc: next, editing: null, selection: this.pruned(next) });
    this.write();
  }

  private pruned(doc: CanvasDoc): Selection {
    const ids = idSet(doc);
    const s = this.state.selection;
    return { nodes: new Set([...s.nodes].filter((id) => ids.has(id))), edges: new Set([...s.edges].filter((id) => ids.has(id))) };
  }

  // ---------- selection, gestures, editing state ----------

  select(nodes: Iterable<string>, edges: Iterable<string> = [], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const n = new Set(mode === 'replace' ? [] : this.state.selection.nodes);
    const e = new Set(mode === 'replace' ? [] : this.state.selection.edges);
    for (const id of nodes) {
      if (mode === 'toggle' && n.has(id)) n.delete(id);
      else n.add(id);
    }
    for (const id of edges) {
      if (mode === 'toggle' && e.has(id)) e.delete(id);
      else e.add(id);
    }
    this.set({ selection: { nodes: n, edges: e } });
  }

  clearSelection(): void {
    if (this.state.selection.nodes.size || this.state.selection.edges.size) this.set({ selection: EMPTY_SELECTION });
  }

  selectAll(): void {
    const doc = this.state.doc;
    if (doc) this.set({ selection: { nodes: new Set(doc.nodes.map((n) => n.id)), edges: new Set(doc.edges.map((e) => e.id)) } });
  }

  setGesture(gesture: Gesture | null): void {
    this.set({ gesture });
  }

  startEditing(id: string): void {
    if (this.state.readOnly) return;
    const node = this.state.doc?.nodes.find((n) => n.id === id);
    if (!node || node.type !== 'text') return;
    this.mergeKey = null;
    this.set({ editing: id, selection: { nodes: new Set([id]), edges: new Set() } });
  }

  stopEditing(): void {
    if (this.state.editing === null) return;
    this.writeNow();
    this.mergeKey = null;
    this.set({ editing: null });
  }

  /** Typing in a card: one undo step per editing session, written after a pause. */
  setNodeText(id: string, text: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.commit(updateNode(doc, id, { text }), { mergeKey: `text:${id}`, deferWrite: true });
  }

  // ---------- the viewport ----------

  /** The stage was measured or resized: the view keeps its centre (a phone turning, a sidebar opening). */
  setStage(width: number, height: number): void {
    const prev = this.stage;
    this.stage = { width, height };
    if (this.measured && (prev.width !== width || prev.height !== height)) {
      const v = this.state.view;
      this.setView({ ...v, x: v.x + (width - prev.width) / 2, y: v.y + (height - prev.height) / 2 });
    }
    this.measured = width > 0 && height > 0;
  }

  get stageSize(): { width: number; height: number } {
    return this.stage;
  }

  setView(view: Viewport): void {
    const v = { x: view.x, y: view.y, zoom: clampZoom(view.zoom) };
    const cur = this.state.view;
    if (v.x !== cur.x || v.y !== cur.y || v.zoom !== cur.zoom) this.set({ view: v });
  }

  panBy(dx: number, dy: number): void {
    const v = this.state.view;
    this.setView({ ...v, x: v.x + dx, y: v.y + dy });
  }

  /** Zooms by `factor` keeping the world point under `screen` (stage coordinates) in place. */
  zoomAt(factor: number, screen: Point): void {
    const v = this.state.view;
    const zoom = clampZoom(v.zoom * factor);
    const k = zoom / v.zoom;
    this.setView({ zoom, x: screen.x - (screen.x - v.x) * k, y: screen.y - (screen.y - v.y) * k });
  }

  zoomBy(factor: number): void {
    this.zoomAt(factor, { x: this.stage.width / 2, y: this.stage.height / 2 });
  }

  screenToWorld(p: Point): Point {
    const v = this.state.view;
    return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
  }

  worldToScreen(p: Point): Point {
    const v = this.state.view;
    return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
  }

  /** The visible world area. */
  visibleRect(): Rect {
    const v = this.state.view;
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, width: this.stage.width / v.zoom, height: this.stage.height / v.zoom };
  }

  viewCenter(): Point {
    return this.screenToWorld({ x: this.stage.width / 2, y: this.stage.height / 2 });
  }

  /** Fits `rect` (default: everything) into the stage with a margin, never above `maxZoom`. */
  zoomToRect(rect: Rect | null, maxZoom = 1): void {
    if (!rect) {
      this.setView({ x: this.stage.width / 2, y: this.stage.height / 2, zoom: 1 });
      return;
    }
    const margin = Math.min(80, Math.min(this.stage.width, this.stage.height) * 0.1);
    const zoom = clampZoom(Math.min(maxZoom, (this.stage.width - 2 * margin) / Math.max(1, rect.width), (this.stage.height - 2 * margin) / Math.max(1, rect.height)));
    this.setView({
      zoom,
      x: this.stage.width / 2 - (rect.x + rect.width / 2) * zoom,
      y: this.stage.height / 2 - (rect.y + rect.height / 2) * zoom,
    });
  }

  zoomToFit(): void {
    const doc = this.state.doc;
    this.zoomToRect(doc ? boundsOf(doc.nodes.map(nodeRect)) : null);
  }

  zoomToSelection(): void {
    const doc = this.state.doc;
    if (!doc) return;
    const rects = doc.nodes.filter((n) => this.state.selection.nodes.has(n.id)).map(nodeRect);
    if (rects.length) this.zoomToRect(boundsOf(rects), 2);
  }

  /** Makes a node comfortably visible (and readable on touch screens) before editing it. */
  reveal(id: string, minZoom: number): void {
    const node = this.state.doc?.nodes.find((n) => n.id === id);
    if (!node) return;
    const r = nodeRect(node);
    const v = this.state.view;
    const zoom = clampZoom(Math.max(v.zoom, Math.min(minZoom, (this.stage.width - 32) / r.width)));
    const visible = this.visibleRect();
    const inside = zoom === v.zoom && r.x >= visible.x && r.y >= visible.y && r.x + r.width <= visible.x + visible.width && r.y + r.height <= visible.y + visible.height;
    if (inside) return;
    // Centred across, its top near the top: on a phone the keyboard covers the lower half.
    this.setView({ zoom, x: this.stage.width / 2 - (r.x + r.width / 2) * zoom, y: this.stage.height * 0.12 - r.y * zoom });
  }

  // ---------- operations ----------

  private edit(fn: (doc: CanvasDoc) => CanvasDoc, opts?: Parameters<CanvasController['commit']>[1]): void {
    const doc = this.state.doc;
    if (doc && !this.state.readOnly) this.commit(fn(doc), opts);
  }

  addText(at: Point, text = '', opts: { edit?: boolean } = {}): string | null {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly) return null;
    const node = makeNode(doc, 'text', at, { text });
    this.commit(addNodes(doc, [node]), { selection: { nodes: new Set([node.id]), edges: new Set() }, editing: opts.edit ? node.id : undefined });
    return node.id;
  }

  addNode(node: Omit<CanvasNode, 'id'>, opts: { select?: boolean } = {}): string | null {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly) return null;
    const full = { id: newId(idSet(doc)), ...node } as CanvasNode;
    this.commit(addNodes(doc, [full]), opts.select === false ? {} : { selection: { nodes: new Set([full.id]), edges: new Set() } });
    return full.id;
  }

  /** Adds several nodes in one undo step. */
  addNodesAt(nodes: Array<Omit<CanvasNode, 'id'>>): string[] {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly || nodes.length === 0) return [];
    const taken = idSet(doc);
    const full = nodes.map((n) => {
      const id = newId(taken);
      taken.add(id);
      return { id, ...n } as CanvasNode;
    });
    this.commit(addNodes(doc, full), { selection: { nodes: new Set(full.map((n) => n.id)), edges: new Set() } });
    return full.map((n) => n.id);
  }

  moveSelection(ids: ReadonlySet<string>, dx: number, dy: number, mergeKey?: string): void {
    this.edit((d) => moveNodes(d, ids, dx, dy), { mergeKey });
  }

  resize(id: string, rect: Rect): void {
    this.edit((d) => setNodeRect(d, id, rect));
  }

  updateNode(id: string, patch: Partial<Record<string, unknown>>): void {
    this.edit((d) => updateNode(d, id, patch));
  }

  /**
   * Points file nodes at the new place of files this page saw move (moves rewrite notes only, so a
   * canvas open here follows them itself; the edit saves like any other).
   */
  followMoves(where: (path: string) => string | null): void {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly) return;
    const next = followMoves(doc, where);
    if (next !== doc) this.commit(next, { mergeKey: 'follow-moves' });
  }

  replaceNode(id: string, node: CanvasNode): void {
    this.edit((d) => replaceNode(d, id, node));
  }

  updateEdge(id: string, patch: Partial<Record<string, unknown>>): void {
    this.edit((d) => updateEdge(d, id, patch));
  }

  connect(from: string, fromSide: CanvasSide, to: string, toSide: CanvasSide): void {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly || from === to) return;
    const edge: CanvasEdge = { id: newId(idSet(doc)), fromNode: from, fromSide, toNode: to, toSide };
    this.commit(addEdges(doc, [edge]), { selection: { nodes: new Set(), edges: new Set([edge.id]) } });
  }

  /** Drops an edge on empty space: a new card there, connected, ready for typing. */
  connectToNewCard(from: string, fromSide: CanvasSide, at: Point, toSide: CanvasSide): void {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly) return;
    const offset = { top: { x: 0, y: 30 }, bottom: { x: 0, y: -30 }, left: { x: 125, y: 0 }, right: { x: -125, y: 0 } }[toSide];
    const node = makeNode(doc, 'text', { x: at.x + offset.x, y: at.y + offset.y }, { text: '' });
    const taken = idSet(doc);
    taken.add(node.id);
    const edge: CanvasEdge = { id: newId(taken), fromNode: from, fromSide, toNode: node.id, toSide };
    this.commit(addEdges(addNodes(doc, [node]), [edge]), { selection: { nodes: new Set([node.id]), edges: new Set() }, editing: node.id });
  }

  deleteSelection(): void {
    const { nodes, edges } = this.state.selection;
    if (!nodes.size && !edges.size) return;
    this.edit((d) => deleteItems(d, nodes, edges), { selection: EMPTY_SELECTION, editing: null });
  }

  setColor(color: string | undefined): void {
    const { nodes, edges } = this.state.selection;
    const value = color && cssColor(color) ? color : undefined;
    this.edit((d) => updateEdges(updateNodes(d, nodes, { color: value }), edges, { color: value }));
  }

  reorder(where: 'front' | 'back'): void {
    const ids = this.state.selection.nodes;
    this.edit((d) => reorder(d, ids, where));
  }

  groupSelection(): string | null {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly) return null;
    const result = groupNodes(doc, this.state.selection.nodes);
    if (!result) return null;
    this.commit(result.doc, { selection: { nodes: new Set([result.id]), edges: new Set() } });
    return result.id;
  }

  // ---------- clipboard ----------

  /** The selection as JSON Canvas text (what Obsidian pastes too), or null when nothing is selected. */
  copySelection(): string | null {
    const doc = this.state.doc;
    if (!doc || this.state.selection.nodes.size === 0) return null;
    const fragment = copyFragment(doc, this.state.selection.nodes);
    const text = JSON.stringify(fragment);
    pageClipboard = { text, fragment };
    this.pasteCount = 0;
    return text;
  }

  cutSelection(): string | null {
    const text = this.copySelection();
    if (text) this.deleteSelection();
    return text;
  }

  /** Pastes a fragment at `at` (default: next to the original, then stepping on). */
  pasteFragment(fragment: CanvasFragment, at?: Point): void {
    const doc = this.state.doc;
    if (!doc || this.state.readOnly) return;
    let target = at;
    if (!target) {
      const b = boundsOf(fragment.nodes.map(nodeRect));
      const visible = this.visibleRect();
      this.pasteCount++;
      const step = 30 * this.pasteCount;
      target = b && b.x + b.width > visible.x && b.x < visible.x + visible.width ? { x: b.x + step, y: b.y + step } : this.viewCenter();
    }
    const result = pasteFragment(doc, fragment, target);
    this.commit(result.doc, { selection: { nodes: new Set(result.ids), edges: new Set() } });
  }

  duplicateSelection(): void {
    const doc = this.state.doc;
    if (!doc || this.state.selection.nodes.size === 0) return;
    const fragment = copyFragment(doc, this.state.selection.nodes);
    const b = boundsOf(fragment.nodes.map(nodeRect));
    if (b) this.pasteFragment(fragment, { x: b.x + 30, y: b.y + 30 });
  }

  static pageClipboard(): { text: string; fragment: CanvasFragment } | null {
    return pageClipboard;
  }
}
