// Pointer, wheel and gesture handling for the canvas stage (ROADMAP item 25), one code path for
// mouse, pen and touch:
//
// | Input | On a node | On an edge | On empty space |
// |---|---|---|---|
// | press and drag | move the selection (groups carry what they contain) | (nothing) | mouse: selection box; touch: pan |
// | tap / click | select (Shift or Mod toggles); links, tags and checkboxes in cards work | select | clear the selection |
// | double tap / click | edit a card, open a file or link, rename a group | edit the label | new card |
// | long press (touch) / right click | menu | menu | menu |
// | two fingers | pinch to zoom and pan | | |
// | wheel | pan (Ctrl or Cmd, or a trackpad pinch: zoom) | | |
//
// Middle-drag or Space-drag pans with a mouse. Corner and side handles resize; the four side dots
// of a node draw an edge (dropped on empty space, it creates a connected card). Moves and resizes
// snap to a 20 px grid unless Alt is held. While a gesture runs only the controller's transient
// `gesture` changes; the document is committed once, on release.
import type { CanvasController } from './controller';
import { clampZoom } from './controller';
import { nodeRect, normalizeRect, rectContains, rectsIntersect, sideAnchor, MIN_HEIGHT, MIN_WIDTH, type CanvasSide, type Point, type Rect } from './model';
import { snap, withGroupContents } from './ops';
import { modKey } from '../../features/platform';

export const GRID = 20;
const SLOP_MOUSE = 4;
const SLOP_TOUCH = 10;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 24;

export interface MenuRequest {
  kind: 'node' | 'edge' | 'background';
  id?: string;
  /** Viewport coordinates, for placing the menu. */
  client: Point;
  /** World coordinates of the press, for adding things there. */
  world: Point;
}

export interface PointerCallbacks {
  menu(req: MenuRequest): void;
  doubleTapNode(id: string, target: Element): void;
  doubleTapEdge(id: string): void;
  doubleTapBackground(world: Point): void;
  /** A tap on something inside a card that acts by itself (link, tag, checkbox, file name); true when handled. */
  activate(target: Element, nodeId: string): boolean;
  spaceHeld(): boolean;
  hover(id: string | null): void;
}

type Track =
  | { kind: 'idle' }
  | { kind: 'ignore' }
  | { kind: 'press-node'; id: string; start: Point; world: Point; additive: boolean; target: Element; touch: boolean }
  | { kind: 'move'; ids: ReadonlySet<string>; primary: string; world: Point }
  | { kind: 'press-edge'; id: string; start: Point; additive: boolean; touch: boolean }
  | { kind: 'press-bg'; start: Point; world: Point; additive: boolean; touch: boolean }
  | { kind: 'pan'; last: Point }
  | { kind: 'marquee'; world: Point; additive: boolean }
  | { kind: 'resize'; id: string; dir: string; rect: Rect; world: Point }
  | { kind: 'connect'; from: string; side: CanvasSide; start: Point }
  | { kind: 'pinch'; d0: number; m0: Point; view0: { x: number; y: number; zoom: number } };

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The topmost node at a world point: cards before groups (a group is behind its contents). */
export function nodeAt(controller: CanvasController, world: Point, exclude?: string): string | null {
  const doc = controller.doc;
  if (!doc) return null;
  let group: string | null = null;
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const n = doc.nodes[i];
    if (n.id === exclude) continue;
    const r = nodeRect(n);
    if (world.x < r.x || world.x > r.x + r.width || world.y < r.y || world.y > r.y + r.height) continue;
    if (n.type !== 'group') return n.id;
    group ??= n.id;
  }
  return group;
}

/** The side of a new card, placed at `at`, that faces `from`. */
export function sideFacing(at: Point, from: Point): CanvasSide {
  const dx = from.x - at.x;
  const dy = from.y - at.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

/** The rectangle after dragging handle `dir` by (dx, dy), at least the minimum size. */
export function resizedRect(r: Rect, dir: string, dx: number, dy: number, grid: number): Rect {
  let x1 = r.x;
  let y1 = r.y;
  let x2 = r.x + r.width;
  let y2 = r.y + r.height;
  if (dir.includes('w')) x1 = Math.min(snap(x1 + dx, grid), x2 - MIN_WIDTH);
  if (dir.includes('e')) x2 = Math.max(snap(x2 + dx, grid), x1 + MIN_WIDTH);
  if (dir.includes('n')) y1 = Math.min(snap(y1 + dy, grid), y2 - MIN_HEIGHT);
  if (dir.includes('s')) y2 = Math.max(snap(y2 + dy, grid), y1 + MIN_HEIGHT);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Nodes a selection box picks: cards it touches, groups it contains whole. */
export function nodesInBox(controller: CanvasController, box: Rect): string[] {
  const doc = controller.doc;
  if (!doc) return [];
  return doc.nodes.filter((n) => (n.type === 'group' ? rectContains(box, nodeRect(n)) : rectsIntersect(box, nodeRect(n)))).map((n) => n.id);
}

function canScroll(el: Element, dx: number, dy: number): boolean {
  if (dy !== 0 && el.scrollHeight > el.clientHeight + 1) {
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  if (dx !== 0 && el.scrollWidth > el.clientWidth + 1) {
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

export class CanvasPointer {
  private readonly stage: HTMLElement;
  private readonly controller: CanvasController;
  private readonly cb: PointerCallbacks;
  private readonly pointers = new Map<number, Point>();
  private track: Track = { kind: 'idle' };
  private longPress: ReturnType<typeof setTimeout> | null = null;
  private lastTap: { at: number; point: Point; key: string } | null = null;
  private lastPointerType = 'mouse';
  private hovered: string | null = null;
  private gestureScale = 1;

  constructor(stage: HTMLElement, controller: CanvasController, cb: PointerCallbacks) {
    this.stage = stage;
    this.controller = controller;
    this.cb = cb;
  }

  attach(): () => void {
    const s = this.stage;
    const opts = { passive: false } as const;
    const handlers: Array<[string, (e: Event) => void, AddEventListenerOptions?]> = [
      ['pointerdown', (e) => this.down(e as PointerEvent)],
      ['pointermove', (e) => this.move(e as PointerEvent)],
      ['pointerup', (e) => this.up(e as PointerEvent, false)],
      ['pointercancel', (e) => this.up(e as PointerEvent, true)],
      ['pointerleave', () => this.setHover(null)],
      ['wheel', (e) => this.wheel(e as WheelEvent), opts],
      ['contextmenu', (e) => this.contextMenu(e as MouseEvent)],
      ['click', (e) => this.click(e as MouseEvent), { capture: true }],
      // Safari: page zoom gestures (iOS) and trackpad pinches (macOS) arrive as gesture events.
      ['gesturestart', (e) => this.gesture(e, true), opts],
      ['gesturechange', (e) => this.gesture(e, false), opts],
      ['gestureend', (e) => e.preventDefault(), opts],
    ];
    for (const [name, fn, o] of handlers) s.addEventListener(name, fn, o);
    return () => {
      for (const [name, fn, o] of handlers) s.removeEventListener(name, fn, o);
      this.cancelLongPress();
    };
  }

  private local(e: { clientX: number; clientY: number }): Point {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.cb.hover(id);
  }

  private cancelLongPress(): void {
    if (this.longPress) clearTimeout(this.longPress);
    this.longPress = null;
  }

  private startLongPress(req: () => MenuRequest): void {
    this.cancelLongPress();
    this.longPress = setTimeout(() => {
      this.longPress = null;
      this.controller.setGesture(null);
      this.track = { kind: 'ignore' };
      this.cb.menu(req());
    }, LONG_PRESS_MS);
  }

  private capture(e: PointerEvent): void {
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone.
    }
  }

  private down(e: PointerEvent): void {
    this.lastPointerType = e.pointerType;
    if (e.button === 2) return;
    const target = e.target as Element;
    // The card editor, floating toolbars and native controls handle their own pointers.
    if (target.closest('.canvas-card-editor, .canvas-ui, audio, video, [data-external-link]')) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const touch = e.pointerType === 'touch';
    if (this.pointers.size === 2 && touch) {
      this.cancelLongPress();
      this.controller.setGesture(null);
      const [a, b] = [...this.pointers.values()];
      this.track = { kind: 'pinch', d0: Math.max(1, dist(a, b)), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view0: this.controller.getState().view };
      this.capture(e);
      return;
    }
    if (this.pointers.size > 1) return;
    if (document.activeElement !== this.stage) this.stage.focus({ preventScroll: true });
    const state = this.controller.getState();
    if (state.editing && !target.closest(`[data-node-id="${CSS.escape(state.editing)}"]`)) this.controller.stopEditing();
    const world = this.controller.screenToWorld(p);
    const editable = !state.readOnly;
    const client = { x: e.clientX, y: e.clientY };

    if (e.button === 1 || (e.button === 0 && this.cb.spaceHeld())) {
      e.preventDefault();
      this.track = { kind: 'pan', last: p };
      this.capture(e);
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]');
    const handleNode = handle?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    if (handle && handleNode && editable) {
      const node = this.controller.doc?.nodes.find((n) => n.id === handleNode);
      if (node) {
        this.track = { kind: 'resize', id: handleNode, dir: handle.dataset.handle ?? 'se', rect: nodeRect(node), world };
        this.capture(e);
        e.preventDefault();
        return;
      }
    }
    const connect = target.closest<HTMLElement>('[data-connect]');
    const connectNode = connect?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    if (connect && connectNode && editable) {
      this.track = { kind: 'connect', from: connectNode, side: connect.dataset.connect as CanvasSide, start: p };
      this.capture(e);
      e.preventDefault();
      return;
    }
    const nodeId = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    if (nodeId) {
      const additive = e.shiftKey || modKey(e);
      if (!state.selection.nodes.has(nodeId) && !additive) this.controller.select([nodeId]);
      this.track = { kind: 'press-node', id: nodeId, start: p, world, additive, target, touch };
      if (touch) this.startLongPress(() => ({ kind: 'node', id: nodeId, client, world }));
      this.capture(e);
      // No text selection or native image drag while pressing a card.
      if (!touch) e.preventDefault();
      return;
    }
    const edgeId = target.closest<HTMLElement>('[data-edge-id]')?.dataset.edgeId;
    if (edgeId) {
      this.track = { kind: 'press-edge', id: edgeId, start: p, additive: e.shiftKey || modKey(e), touch };
      if (touch) this.startLongPress(() => ({ kind: 'edge', id: edgeId, client, world }));
      this.capture(e);
      return;
    }
    this.track = { kind: 'press-bg', start: p, world, additive: e.shiftKey || modKey(e), touch };
    if (touch) this.startLongPress(() => ({ kind: 'background', client, world }));
    this.capture(e);
    if (!touch) e.preventDefault();
  }

  private move(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        const id = (e.target as Element).closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
        this.setHover(id);
      }
      return;
    }
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const t = this.track;
    const state = this.controller.getState();
    switch (t.kind) {
      case 'pinch': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoom = clampZoom((t.view0.zoom * dist(a, b)) / t.d0);
        const wx = (t.m0.x - t.view0.x) / t.view0.zoom;
        const wy = (t.m0.y - t.view0.y) / t.view0.zoom;
        this.controller.setView({ zoom, x: m.x - wx * zoom, y: m.y - wy * zoom });
        return;
      }
      case 'press-node': {
        if (dist(p, t.start) <= (t.touch ? SLOP_TOUCH : SLOP_MOUSE)) return;
        this.cancelLongPress();
        if (state.readOnly) {
          this.track = { kind: 'pan', last: p };
          return;
        }
        const doc = this.controller.doc;
        if (!doc) return;
        const selected = new Set(state.selection.nodes);
        selected.add(t.id);
        if (selected.size !== state.selection.nodes.size) this.controller.select(selected, state.selection.edges, 'replace');
        this.track = { kind: 'move', ids: withGroupContents(doc, selected), primary: t.id, world: t.world };
        this.move(e);
        return;
      }
      case 'move': {
        const world = this.controller.screenToWorld(p);
        let dx = world.x - t.world.x;
        let dy = world.y - t.world.y;
        const primary = this.controller.doc?.nodes.find((n) => n.id === t.primary);
        if (primary && !e.altKey) {
          const r = nodeRect(primary);
          dx = snap(r.x + dx, GRID) - r.x;
          dy = snap(r.y + dy, GRID) - r.y;
        }
        this.controller.setGesture({ kind: 'move', ids: t.ids, dx, dy });
        return;
      }
      case 'press-bg':
        if (dist(p, t.start) <= (t.touch ? SLOP_TOUCH : SLOP_MOUSE)) return;
        this.cancelLongPress();
        this.track = t.touch ? { kind: 'pan', last: t.start } : { kind: 'marquee', world: t.world, additive: t.additive };
        this.move(e);
        return;
      case 'press-edge':
        if (dist(p, t.start) <= (t.touch ? SLOP_TOUCH : SLOP_MOUSE)) return;
        this.cancelLongPress();
        this.track = t.touch ? { kind: 'pan', last: t.start } : { kind: 'ignore' };
        this.move(e);
        return;
      case 'pan':
        this.controller.panBy(p.x - t.last.x, p.y - t.last.y);
        this.track = { kind: 'pan', last: p };
        return;
      case 'marquee':
        this.controller.setGesture({ kind: 'marquee', rect: normalizeRect(t.world, this.controller.screenToWorld(p)) });
        return;
      case 'resize': {
        const world = this.controller.screenToWorld(p);
        this.controller.setGesture({ kind: 'resize', id: t.id, rect: resizedRect(t.rect, t.dir, world.x - t.world.x, world.y - t.world.y, e.altKey ? 0 : GRID) });
        return;
      }
      case 'connect': {
        const world = this.controller.screenToWorld(p);
        this.controller.setGesture({ kind: 'connect', from: t.from, side: t.side, to: world, target: nodeAt(this.controller, world, t.from) });
        return;
      }
      default:
    }
  }

  private isDoubleTap(key: string, point: Point): boolean {
    const now = Date.now();
    const last = this.lastTap;
    if (last && last.key === key && now - last.at < DOUBLE_TAP_MS && dist(last.point, point) < DOUBLE_TAP_SLOP) {
      this.lastTap = null;
      return true;
    }
    this.lastTap = { at: now, point, key };
    return false;
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.cancelLongPress();
    const t = this.track;
    if (t.kind === 'pinch') {
      // The remaining finger does nothing until it lifts too.
      this.track = this.pointers.size > 0 ? { kind: 'ignore' } : { kind: 'idle' };
      return;
    }
    this.track = { kind: 'idle' };
    const c = this.controller;
    const gesture = c.getState().gesture;
    if (cancelled) {
      if (gesture) c.setGesture(null);
      return;
    }
    const p = this.local(e);
    switch (t.kind) {
      case 'press-node': {
        if (t.additive) {
          c.select([t.id], [], 'toggle');
          return;
        }
        const sel = c.getState().selection;
        if (sel.nodes.size > 1 || sel.edges.size > 0) c.select([t.id]);
        if (this.cb.activate(t.target, t.id)) return;
        if (this.isDoubleTap(`n:${t.id}`, p)) this.cb.doubleTapNode(t.id, t.target);
        return;
      }
      case 'move':
        c.setGesture(null);
        if (gesture?.kind === 'move' && (gesture.dx !== 0 || gesture.dy !== 0)) c.moveSelection(gesture.ids, gesture.dx, gesture.dy);
        return;
      case 'press-bg':
        if (!t.additive) c.clearSelection();
        if (this.isDoubleTap('bg', p)) this.cb.doubleTapBackground(t.world);
        return;
      case 'press-edge':
        c.select([], [t.id], t.additive ? 'toggle' : 'replace');
        if (this.isDoubleTap(`e:${t.id}`, p)) this.cb.doubleTapEdge(t.id);
        return;
      case 'marquee':
        c.setGesture(null);
        if (gesture?.kind === 'marquee') c.select(nodesInBox(c, gesture.rect), [], t.additive ? 'add' : 'replace');
        return;
      case 'resize':
        c.setGesture(null);
        if (gesture?.kind === 'resize') c.resize(t.id, gesture.rect);
        return;
      case 'connect': {
        c.setGesture(null);
        if (gesture?.kind !== 'connect' || dist(p, t.start) < SLOP_TOUCH) return;
        const fromNode = c.doc?.nodes.find((n) => n.id === t.from);
        if (!fromNode) return;
        const world = gesture.to;
        const target = gesture.target ? c.doc?.nodes.find((n) => n.id === gesture.target) : undefined;
        if (target) {
          const r = nodeRect(target);
          const anchor = sideAnchor(nodeRect(fromNode), t.side);
          // The side facing the pointer, as Obsidian picks it.
          const toSide = sideOfRectFacing(r, world, anchor);
          c.connect(t.from, t.side, target.id, toSide);
        } else {
          c.connectToNewCard(t.from, t.side, world, sideFacing(world, sideAnchor(nodeRect(fromNode), t.side)));
        }
        return;
      }
      default:
        if (gesture) c.setGesture(null);
    }
  }

  private click(e: MouseEvent): void {
    // Links and checkboxes inside cards act on pointer release (activate); keep the browser's own
    // click from navigating or toggling as well.
    const target = e.target as Element;
    if (target.closest('.canvas-card-editor, .canvas-ui, [data-external-link]')) return;
    if (target.closest('a, input[type="checkbox"]')) e.preventDefault();
  }

  private contextMenu(e: MouseEvent): void {
    const target = e.target as Element;
    if (target.closest('.canvas-card-editor, .canvas-ui')) return;
    e.preventDefault();
    // Touch screens open menus by long press (some also send contextmenu: ignore it).
    if (this.lastPointerType === 'touch') return;
    const world = this.controller.screenToWorld(this.local(e));
    const client = { x: e.clientX, y: e.clientY };
    const nodeId = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    const state = this.controller.getState();
    if (nodeId) {
      if (!state.selection.nodes.has(nodeId)) this.controller.select([nodeId]);
      this.cb.menu({ kind: 'node', id: nodeId, client, world });
      return;
    }
    const edgeId = target.closest<HTMLElement>('[data-edge-id]')?.dataset.edgeId;
    if (edgeId) {
      if (!state.selection.edges.has(edgeId)) this.controller.select([], [edgeId]);
      this.cb.menu({ kind: 'edge', id: edgeId, client, world });
      return;
    }
    this.cb.menu({ kind: 'background', client, world });
  }

  private wheel(e: WheelEvent): void {
    const target = e.target as Element;
    if (target.closest('.canvas-ui')) return;
    const zoom = e.ctrlKey || e.metaKey;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.stage.clientHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (!zoom) {
      // A selected or edited card scrolls its own content while it can.
      const scroller = target.closest('.canvas-node.is-selected .canvas-node-container, .canvas-card-editor .cm-scroller');
      if (scroller && canScroll(scroller, dx, dy)) return;
    }
    e.preventDefault();
    if (zoom) {
      // Trackpad pinches send many small deltas; a Ctrl-wheel notch (about 100) zooms by about 20 %.
      const step = Math.max(-0.18, Math.min(0.18, -dy * 0.01));
      this.controller.zoomAt(Math.exp(step), this.local(e));
      return;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.controller.panBy(-dx, -dy);
  }

  private gesture(e: Event, start: boolean): void {
    e.preventDefault();
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    if (start) {
      this.gestureScale = 1;
      return;
    }
    // iOS pinches arrive as pointers too; only a macOS trackpad pinch (no pointers) zooms here.
    if (this.pointers.size > 0 || typeof g.scale !== 'number') return;
    const factor = g.scale / this.gestureScale;
    this.gestureScale = g.scale;
    const at = typeof g.clientX === 'number' ? this.local({ clientX: g.clientX, clientY: g.clientY ?? 0 }) : { x: this.stage.clientWidth / 2, y: this.stage.clientHeight / 2 };
    this.controller.zoomAt(factor, at);
  }
}

/** The side of `r` an edge dropped at `drop`, coming from `from`, should attach to. */
function sideOfRectFacing(r: Rect, drop: Point, from: Point): CanvasSide {
  // Use the drop point when it is clearly near one side, otherwise the direction of the source.
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const nx = (drop.x - cx) / Math.max(1, r.width / 2);
  const ny = (drop.y - cy) / Math.max(1, r.height / 2);
  if (Math.max(Math.abs(nx), Math.abs(ny)) > 0.5) {
    if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? 'right' : 'left';
    return ny >= 0 ? 'bottom' : 'top';
  }
  const dx = from.x - cx;
  const dy = from.y - cy;
  if (Math.abs(dx) / Math.max(1, r.width) >= Math.abs(dy) / Math.max(1, r.height)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}
