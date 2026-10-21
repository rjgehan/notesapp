// The interactive graph (ROADMAP item 16, DESIGN §6.28): a canvas fed by the force layout, with
// pan and zoom (wheel, trackpad pinch, two-finger pinch on touch), node dragging, hover (or press)
// highlighting of a node's neighbours, and click or tap to open. Nothing here re-renders React per
// frame: positions and the view transform live in refs and are drawn on animation frames.
import { Maximize, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { adjacency, type ViewGraph, type ViewNode } from '../../features/graph/model';
import type { DisplayOptions, ForceOptions } from '../../features/graph/options';
import { createLayoutClient, type LayoutClient } from '../../features/graph/layoutClient';
import type { PositionsMessage } from '../../features/graph/runner';
import { bucketsOf, clampZoom, drawFrame, FALLBACK_THEME, fitTransform, hitTest, nodeFills, nodeRadius, readTheme, toWorld, zoomAround, type GraphTheme, type Transform } from './renderer';

export interface GraphCanvasProps {
  view: ViewGraph;
  /** Group colors aligned with `view.nodes` (null: the type's color). */
  groupColors: readonly (string | null)[];
  display: DisplayOptions;
  forces: ForceOptions;
  /** Highlighted as the open note (the local graph's center comes from the view). */
  focusId?: string | null;
  onOpen(node: ViewNode): void;
  label: string;
  /** Smaller controls (the local graph panel). */
  compact?: boolean;
}

interface Down {
  pointerId: number;
  x: number;
  y: number;
  time: number;
  node: number;
  moved: boolean;
  touch: boolean;
}

interface Pinch {
  distance: number;
  midX: number;
  midY: number;
  transform: Transform;
}

const CLICK_SLOP = 5;

export function GraphCanvas({ view, groupColors, display, forces, focusId, onOpen, label, compact }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<LayoutClient | null>(null);
  const s = useRef({
    transform: { x: 0, y: 0, k: 1 } as Transform,
    positions: null as Float32Array | null,
    generation: 0,
    width: 0,
    height: 0,
    dpr: 1,
    hover: -1,
    userMoved: false,
    lastFit: 0,
    frame: 0,
    theme: FALLBACK_THEME as GraphTheme,
    view,
    radii: new Float32Array(0),
    fills: [] as string[],
    buckets: [] as Array<{ color: string; nodes: Int32Array }>,
    highlighted: null as Uint8Array | null,
    focus: -1,
    display,
    down: null as Down | null,
    dragging: -1,
    pointers: new Map<number, { x: number; y: number }>(),
    pinch: null as Pinch | null,
    ids: [] as string[],
  });
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  const draw = useCallback(() => {
    const st = s.current;
    st.frame = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The zoom and hover, for tests and diagnostics.
    canvas.dataset.zoom = st.transform.k.toFixed(3);
    canvas.dataset.hover = st.hover >= 0 ? (st.view.nodes[st.hover]?.id ?? '') : '';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawFrame(ctx, {
      width: st.width,
      height: st.height,
      dpr: st.dpr,
      transform: st.transform,
      view: st.view,
      positions: st.positions,
      radii: st.radii,
      buckets: st.buckets,
      theme: st.theme,
      display: st.display,
      hover: st.hover,
      highlighted: st.highlighted,
      focus: st.focus,
    });
  }, []);

  const requestDraw = useCallback(() => {
    const st = s.current;
    if (st.frame) return;
    st.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(draw) : (setTimeout(draw, 16) as unknown as number);
  }, [draw]);

  const fit = useCallback(
    (force = false) => {
      const st = s.current;
      if (!st.positions || (!force && st.userMoved)) return;
      st.transform = fitTransform(st.positions, st.view.nodes.length, st.width, st.height, compact ? 28 : 48, compact ? 2.5 : 2);
      requestDraw();
    },
    [compact, requestDraw],
  );

  const setHover = useCallback(
    (index: number) => {
      const st = s.current;
      if (st.hover === index) return;
      st.hover = index;
      if (index < 0) st.highlighted = null;
      else {
        const adj = adjacency(st.view);
        const set = new Uint8Array(st.view.nodes.length);
        set[index] = 1;
        for (let j = adj.offsets[index]!; j < adj.offsets[index + 1]!; j++) set[adj.targets[j]!] = 1;
        st.highlighted = set;
      }
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = index >= 0 ? 'pointer' : st.down ? 'grabbing' : 'default';
      requestDraw();
    },
    [requestDraw],
  );

  // ---------- layout lifecycle ----------
  useEffect(() => {
    const state = s.current;
    const client = createLayoutClient(forces, (message: PositionsMessage) => {
      const st = state;
      if (message.generation !== st.generation) return;
      if (message.positions.length !== st.view.nodes.length * 2) return;
      st.positions = message.positions;
      const now = Date.now();
      if (!st.userMoved && (now - st.lastFit > 250 || !message.running)) {
        st.lastFit = now;
        fit();
      }
      requestDraw();
    });
    layoutRef.current = client;
    return () => {
      client.dispose();
      layoutRef.current = null;
      if (state.frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.frame);
        state.frame = 0;
      }
    };
    // The client lives as long as the component; forces are sent by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    layoutRef.current?.setForces(forces);
  }, [forces]);

  // ---------- view changes ----------
  const radii = useMemo(() => Float32Array.from(view.nodes, (n) => nodeRadius(n.degree, display.nodeSizeMultiplier)), [view, display.nodeSizeMultiplier]);

  useEffect(() => {
    const st = s.current;
    const previous = new Map<string, number>();
    st.ids.forEach((id, i) => previous.set(id, i));
    const ids = view.nodes.map((n) => n.id);
    // Interim positions by id, so the frame before the layout answers shows the same picture.
    let known = 0;
    let interim: Float32Array | null = null;
    if (st.positions) {
      interim = new Float32Array(ids.length * 2).fill(NaN);
      for (let i = 0; i < ids.length; i++) {
        const old = previous.get(ids[i]!);
        if (old !== undefined && old * 2 + 1 < st.positions.length) {
          interim[i * 2] = st.positions[old * 2]!;
          interim[i * 2 + 1] = st.positions[old * 2 + 1]!;
          known++;
        }
      }
    }
    if (st.dragging >= 0) st.dragging = -1;
    st.down = null;
    st.ids = ids;
    st.view = view;
    st.positions = interim;
    st.hover = -1;
    st.highlighted = null;
    const pairs = new Int32Array((view.links.length / 3) * 2);
    for (let j = 0, p = 0; j < view.links.length; j += 3) {
      pairs[p++] = view.links[j]!;
      pairs[p++] = view.links[j + 1]!;
    }
    const fresh = ids.length === 0 || known < ids.length * 0.7;
    if (fresh && previous.size === 0) st.userMoved = false;
    st.generation = layoutRef.current?.setGraph({ ids, links: pairs }, fresh ? 1 : 0.3) ?? 0;
    requestDraw();
  }, [view, requestDraw]);

  useEffect(() => {
    const st = s.current;
    st.radii = radii;
    st.display = display;
    requestDraw();
  }, [radii, display, requestDraw]);

  useEffect(() => {
    const st = s.current;
    st.fills = nodeFills(view, groupColors, st.theme);
    st.buckets = bucketsOf(st.fills);
    const center = view.center >= 0 ? view.center : focusId ? view.nodes.findIndex((n) => n.id === focusId) : -1;
    st.focus = center;
    requestDraw();
  }, [view, groupColors, focusId, requestDraw]);

  // ---------- size, theme ----------
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const st = s.current;
    const applyTheme = () => {
      st.theme = readTheme(container);
      st.fills = nodeFills(st.view, groupColors, st.theme);
      st.buckets = bucketsOf(st.fills);
      requestDraw();
    };
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const changed = rect.width !== st.width || rect.height !== st.height;
      st.width = rect.width;
      st.height = rect.height;
      st.dpr = dpr;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      if (changed && !st.userMoved) fit();
      requestDraw();
    };
    applyTheme();
    resize();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    ro?.observe(container);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(applyTheme) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
    // groupColors is re-applied by the view effect; the theme only needs it at the time of a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, requestDraw]);

  // ---------- pointer and wheel ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = s.current;
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    const hit = (sx: number, sy: number, touch: boolean) => {
      const [wx, wy] = toWorld(st.transform, sx, sy);
      return hitTest(st.positions, st.radii, st.view.nodes.length, wx, wy, st.transform.k, touch ? 14 : 5);
    };
    const releaseDrag = () => {
      if (st.dragging >= 0) layoutRef.current?.release(st.dragging);
      st.dragging = -1;
    };
    const startPinch = () => {
      const [a, b] = [...st.pointers.values()];
      if (!a || !b) return;
      st.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, transform: { ...st.transform } };
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      canvas.focus({ preventScroll: true });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events in tests have no active pointer.
      }
      const [x, y] = local(e);
      st.pointers.set(e.pointerId, { x, y });
      if (st.pointers.size === 1) {
        const touch = e.pointerType !== 'mouse';
        const node = hit(x, y, touch);
        st.down = { pointerId: e.pointerId, x, y, time: Date.now(), node, moved: false, touch };
        setHover(node);
      } else if (st.pointers.size === 2) {
        releaseDrag();
        if (st.down) st.down.moved = true;
        setHover(-1);
        startPinch();
      }
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      const [x, y] = local(e);
      const pointer = st.pointers.get(e.pointerId);
      if (!pointer) {
        if (e.pointerType === 'mouse' && st.pointers.size === 0) setHover(hit(x, y, false));
        return;
      }
      const lastX = pointer.x;
      const lastY = pointer.y;
      pointer.x = x;
      pointer.y = y;
      if (st.pointers.size >= 2 && st.pinch) {
        const [a, b] = [...st.pointers.values()];
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
        const midX = (a!.x + b!.x) / 2;
        const midY = (a!.y + b!.y) / 2;
        const p = st.pinch;
        const k = clampZoom(p.transform.k * (distance / p.distance));
        const [wx, wy] = toWorld(p.transform, p.midX, p.midY);
        st.transform = { k, x: midX - wx * k, y: midY - wy * k };
        st.userMoved = true;
        requestDraw();
        return;
      }
      const down = st.down;
      if (!down || down.pointerId !== e.pointerId) return;
      if (!down.moved && Math.hypot(x - down.x, y - down.y) > CLICK_SLOP) down.moved = true;
      if (!down.moved) return;
      if (down.node >= 0) {
        const [wx, wy] = toWorld(st.transform, x, y);
        st.dragging = down.node;
        layoutRef.current?.drag(down.node, wx, wy);
        if (st.positions) {
          st.positions[down.node * 2] = wx;
          st.positions[down.node * 2 + 1] = wy;
        }
      } else {
        st.transform = { ...st.transform, x: st.transform.x + (x - lastX), y: st.transform.y + (y - lastY) };
        st.userMoved = true;
        canvas.style.cursor = 'grabbing';
      }
      requestDraw();
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!st.pointers.has(e.pointerId)) return;
      st.pointers.delete(e.pointerId);
      const down = st.down;
      if (down && down.pointerId === e.pointerId) {
        const elapsed = Date.now() - down.time;
        const node = down.node;
        releaseDrag();
        st.down = null;
        canvas.style.cursor = 'default';
        if (down.touch) setHover(-1);
        if (!cancelled && !down.moved && node >= 0 && elapsed < 900) {
          const target = st.view.nodes[node];
          if (target) onOpenRef.current(target);
        }
      }
      if (st.pointers.size < 2) st.pinch = null;
      if (st.pointers.size === 1) {
        // One finger left after a pinch pans from where it is.
        const [id, p] = [...st.pointers.entries()][0]!;
        st.down = { pointerId: id, x: p.x, y: p.y, time: Date.now(), node: -1, moved: true, touch: true };
      }
    };
    const onPointerUp = (e: PointerEvent) => finish(e, false);
    const onPointerCancel = (e: PointerEvent) => finish(e, true);
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && st.pointers.size === 0) setHover(-1);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = local(e);
      // Trackpad pinches arrive as wheel events with ctrlKey and small deltas.
      const scale = e.ctrlKey ? 0.01 : e.deltaMode === 1 ? 0.05 : 0.0015;
      st.transform = zoomAround(st.transform, x, y, Math.exp(-e.deltaY * scale));
      st.userMoved = true;
      requestDraw();
    };
    // Safari's own pinch gestures would zoom the page.
    const onGesture = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', onGesture);
    canvas.addEventListener('gesturechange', onGesture);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', onGesture);
      canvas.removeEventListener('gesturechange', onGesture);
    };
  }, [requestDraw, setHover]);

  const zoomBy = (factor: number) => {
    const st = s.current;
    st.transform = zoomAround(st.transform, st.width / 2, st.height / 2, factor);
    st.userMoved = true;
    requestDraw();
  };
  const fitNow = () => {
    s.current.userMoved = false;
    fit(true);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const st = s.current;
    const step = 60;
    switch (e.key) {
      case '+':
      case '=':
        zoomBy(1.25);
        break;
      case '-':
      case '_':
        zoomBy(0.8);
        break;
      case '0':
        fitNow();
        break;
      case 'ArrowLeft':
        st.transform = { ...st.transform, x: st.transform.x + step };
        break;
      case 'ArrowRight':
        st.transform = { ...st.transform, x: st.transform.x - step };
        break;
      case 'ArrowUp':
        st.transform = { ...st.transform, y: st.transform.y + step };
        break;
      case 'ArrowDown':
        st.transform = { ...st.transform, y: st.transform.y - step };
        break;
      default:
        return;
    }
    st.userMoved = true;
    e.preventDefault();
    requestDraw();
  };

  return (
    <div className={`graph-canvas${compact ? ' is-compact' : ''}`} ref={containerRef}>
      <canvas ref={canvasRef} className="graph-canvas-surface" role="img" aria-label={label} tabIndex={0} onKeyDown={onKeyDown} />
      <div className="graph-zoom" role="group" aria-label="Zoom">
        <button type="button" className="graph-zoom-button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.3)}>
          <Plus size={16} aria-hidden />
        </button>
        <button type="button" className="graph-zoom-button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          <Minus size={16} aria-hidden />
        </button>
        <button type="button" className="graph-zoom-button" aria-label="Fit the graph" title="Fit the graph" onClick={fitNow}>
          <Maximize size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}
