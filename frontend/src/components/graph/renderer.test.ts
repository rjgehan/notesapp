import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_OPTIONS } from '../../features/graph/options';
import type { ViewGraph, ViewNode } from '../../features/graph/model';
import { bucketsOf, drawFrame, FALLBACK_THEME, fitTransform, hitTest, labelAlpha, MAX_ZOOM, MIN_ZOOM, nodeFills, nodeRadius, toWorld, zoomAround } from './renderer';

const vnode = (id: string, type: ViewNode['type'], degree = 1): ViewNode => ({ id, path: id, label: id, type, tags: [], aliases: [], degree });

describe('graph renderer geometry', () => {
  it('zooms around a fixed screen point and clamps the zoom', () => {
    const t = { x: 100, y: 50, k: 1 };
    const z = zoomAround(t, 200, 150, 2);
    expect(z.k).toBe(2);
    expect(toWorld(z, 200, 150)).toEqual(toWorld(t, 200, 150));
    expect(zoomAround(t, 0, 0, 1e6).k).toBe(MAX_ZOOM);
    expect(zoomAround(t, 0, 0, 1e-6).k).toBe(MIN_ZOOM);
  });

  it('fits placed nodes into the viewport, ignoring unplaced ones', () => {
    const p = Float32Array.from([-100, -50, 100, 50, NaN, NaN]);
    const t = fitTransform(p, 3, 400, 300, 0, 10);
    expect(t.k).toBeCloseTo(2);
    expect(t.x).toBeCloseTo(200);
    expect(t.y).toBeCloseTo(150);
    expect(fitTransform(new Float32Array(0), 0, 400, 300)).toEqual({ x: 200, y: 150, k: 1 });
  });

  it('finds the node under the pointer with some slack, preferring the closest', () => {
    const p = Float32Array.from([0, 0, 30, 0]);
    const r = Float32Array.from([5, 5]);
    expect(hitTest(p, r, 2, 2, 0, 1, 0)).toBe(0);
    expect(hitTest(p, r, 2, 28, 1, 1, 0)).toBe(1);
    expect(hitTest(p, r, 2, 15, 0, 1, 0)).toBe(-1);
    expect(hitTest(p, r, 2, 15, 0, 1, 12)).toBe(0);
    expect(hitTest(null, r, 2, 0, 0, 1, 5)).toBe(-1);
  });

  it('grows nodes with their links and fades labels in with the zoom', () => {
    expect(nodeRadius(0, 1)).toBeLessThan(nodeRadius(16, 1));
    expect(nodeRadius(10_000, 1)).toBe(22);
    expect(labelAlpha(0.2, 0)).toBe(0);
    expect(labelAlpha(3, 0)).toBe(1);
    expect(labelAlpha(0.6, 3)).toBeGreaterThan(labelAlpha(0.6, 0));
  });

  it('colors nodes by group, then by type, and draws in batches', () => {
    const view: ViewGraph = {
      nodes: [vnode('a.md', 'note', 1), vnode('b.md', 'note', 2), vnode('pic.png', 'attachment', 1), vnode('#t', 'tag', 0)],
      links: Int32Array.from([0, 1, 1, 1, 2, 3]),
      center: -1,
    };
    const fills = nodeFills(view, ['#ff0000', null, null, null], FALLBACK_THEME);
    expect(fills).toEqual(['#ff0000', FALLBACK_THEME.node, FALLBACK_THEME.attachment, FALLBACK_THEME.tag]);
    const buckets = bucketsOf(fills);
    expect(buckets.map((b) => [b.color, [...b.nodes]])).toEqual([
      ['#ff0000', [0]],
      [FALLBACK_THEME.node, [1]],
      [FALLBACK_THEME.attachment, [2]],
      [FALLBACK_THEME.tag, [3]],
    ]);

    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, prop: string) => (prop in target ? target[prop] : (...args: unknown[]) => calls.push(`${prop}(${args.length})`)),
      set: (target, prop: string, value) => {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const positions = Float32Array.from([0, 0, 40, 0, 40, 40, 0, 40]);
    drawFrame(ctx, {
      width: 400,
      height: 300,
      dpr: 2,
      transform: { x: 200, y: 150, k: 2 },
      view,
      positions,
      radii: Float32Array.from(view.nodes, (n) => nodeRadius(n.degree, 1)),
      buckets,
      theme: FALLBACK_THEME,
      display: { ...DEFAULT_GRAPH_OPTIONS, showArrow: true },
      hover: 1,
      highlighted: Uint8Array.from([1, 1, 1, 0]),
      focus: 0,
    });
    // One stroke per link style (dimmed, highlighted), fills per color and pass, labels as text.
    expect(calls.filter((c) => c.startsWith('stroke(')).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.startsWith('fillText(')).length).toBe(3);
    expect(calls.filter((c) => c.startsWith('arc(')).length).toBeGreaterThanOrEqual(4);
  });
});
