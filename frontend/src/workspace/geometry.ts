// Where each pane and divider of a layout sits, in fractions of the workspace (DESIGN §6.38). Panes
// render as a flat, absolutely positioned list keyed by pane id, so splitting, closing or resizing
// never remounts a pane (its editor, scroll position and focus stay).
import { MIN_PANE_FRACTION, type Layout, type SplitDir } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  split: string;
  /** Between child `index - 1` and child `index`. */
  index: number;
  dir: SplitDir;
  /** The split's own rectangle. */
  parent: Rect;
  /** The divider's position along the split's axis, in workspace fractions. */
  at: number;
  sizes: number[];
}

export function layoutGeometry(layout: Layout, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): { panes: Record<string, Rect>; dividers: Divider[] } {
  const panes: Record<string, Rect> = {};
  const dividers: Divider[] = [];
  const walk = (l: Layout, r: Rect) => {
    if (l.type === 'pane') {
      panes[l.id] = r;
      return;
    }
    let offset = 0;
    l.children.forEach((child, i) => {
      const size = l.sizes[i];
      const childRect = l.dir === 'row' ? { x: r.x + offset * r.w, y: r.y, w: size * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: size * r.h };
      if (i > 0) dividers.push({ split: l.id, index: i, dir: l.dir, parent: r, at: l.dir === 'row' ? childRect.x : childRect.y, sizes: l.sizes });
      walk(child, childRect);
      offset += size;
    });
  };
  walk(layout, rect);
  return { panes, dividers };
}

/**
 * The sizes after dragging divider `index` to `local`, a fraction of the split's own length: only
 * the two neighbours change, each keeps at least MIN_PANE_FRACTION.
 */
export function dragDivider(sizes: number[], index: number, local: number): number[] {
  const start = sizes.slice(0, index - 1).reduce((a, b) => a + b, 0);
  const pair = sizes[index - 1] + sizes[index];
  const min = Math.min(MIN_PANE_FRACTION, pair / 2);
  const left = Math.max(min, Math.min(pair - min, local - start));
  const next = [...sizes];
  next[index - 1] = left;
  next[index] = pair - left;
  return next;
}

/** Which drop zone of a pane a point falls in: an edge quarter splits, the middle moves the tab there. */
export function dropZone(x: number, y: number): 'left' | 'right' | 'up' | 'down' | 'center' {
  // x and y are fractions of the pane's width and height.
  const edges = [
    { zone: 'left' as const, d: x },
    { zone: 'right' as const, d: 1 - x },
    { zone: 'up' as const, d: y },
    { zone: 'down' as const, d: 1 - y },
  ].sort((a, b) => a.d - b.d);
  return edges[0].d < 0.25 ? edges[0].zone : 'center';
}
