// Canvas drawing and geometry for the graph view (ROADMAP item 16, DESIGN §6.21). Everything is
// batched: one path for all links of a style, one path per node color, so a 10,000-note graph is a
// handful of canvas calls per frame. Off-screen nodes and links are skipped, and labels appear only
// when zoomed in (or for the hovered node and its neighbours), as in Obsidian.
import type { ViewGraph } from '../../features/graph/model';
import type { DisplayOptions } from '../../features/graph/options';

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

export interface GraphTheme {
  background: string;
  line: string;
  lineHighlight: string;
  node: string;
  unresolved: string;
  tag: string;
  attachment: string;
  focused: string;
  text: string;
  font: string;
}

export const FALLBACK_THEME: GraphTheme = {
  background: '#1e1e1e',
  line: 'rgba(255,255,255,0.16)',
  lineHighlight: '#8a5cf5',
  node: '#9a9a9a',
  unresolved: '#5c5c5c',
  tag: '#5fb878',
  attachment: '#d4b44a',
  focused: '#8a5cf5',
  text: '#dadada',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

/** The theme from CSS variables on `el` (set by graph.css for both themes). */
export function readTheme(el: Element): GraphTheme {
  const style = getComputedStyle(el);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--graph-background', FALLBACK_THEME.background),
    line: v('--graph-line', FALLBACK_THEME.line),
    lineHighlight: v('--graph-line-highlight', FALLBACK_THEME.lineHighlight),
    node: v('--graph-node', FALLBACK_THEME.node),
    unresolved: v('--graph-node-unresolved', FALLBACK_THEME.unresolved),
    tag: v('--graph-node-tag', FALLBACK_THEME.tag),
    attachment: v('--graph-node-attachment', FALLBACK_THEME.attachment),
    focused: v('--graph-node-focused', FALLBACK_THEME.focused),
    text: v('--graph-text', FALLBACK_THEME.text),
    font: v('--font-text', FALLBACK_THEME.font),
  };
}

/** World radius of a node: grows with the square root of its links, like Obsidian's. */
export function nodeRadius(degree: number, sizeMultiplier: number): number {
  return sizeMultiplier * Math.min(3 + Math.sqrt(degree) * 1.25, 22);
}

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

export function toWorld(t: Transform, sx: number, sy: number): [number, number] {
  return [(sx - t.x) / t.k, (sy - t.y) / t.k];
}

/** `t` zoomed by `factor` around the screen point (sx, sy), which stays put. */
export function zoomAround(t: Transform, sx: number, sy: number, factor: number): Transform {
  const k = clampZoom(t.k * factor);
  const [wx, wy] = toWorld(t, sx, sy);
  return { k, x: sx - wx * k, y: sy - wy * k };
}

/** The transform that fits every placed node into width × height with `padding` pixels around. */
export function fitTransform(positions: Float32Array, count: number, width: number, height: number, padding = 40, maxZoom = 1.5): Transform {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, k: 1 };
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const k = clampZoom(Math.min((width - padding * 2) / w, (height - padding * 2) / h, maxZoom));
  return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
}

/** The node under world point (wx, wy) within `slack` screen pixels of its edge, or -1. */
export function hitTest(positions: Float32Array | null, radii: Float32Array, count: number, wx: number, wy: number, k: number, slack: number): number {
  if (!positions) return -1;
  let best = -1;
  let bestDistance = Infinity;
  const extra = slack / k;
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 2]! - wx;
    const dy = positions[i * 2 + 1]! - wy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const reach = Math.max(radii[i]!, 2 / k) + extra;
    if (d <= reach && d - radii[i]! < bestDistance) {
      best = i;
      bestDistance = d - radii[i]!;
    }
  }
  return best;
}

/** Labels appear around this zoom; Obsidian's text fade slider moves it (higher = sooner). */
export function labelAlpha(k: number, textFade: number): number {
  const threshold = 1.2 * Math.pow(2, -textFade / 1.5);
  return Math.min(1, Math.max(0, (k - threshold * 0.75) / (threshold * 0.5)));
}

export interface Frame {
  width: number;
  height: number;
  dpr: number;
  transform: Transform;
  view: ViewGraph;
  positions: Float32Array | null;
  radii: Float32Array;
  /** Node indexes per fill color. */
  buckets: Array<{ color: string; nodes: Int32Array }>;
  theme: GraphTheme;
  display: DisplayOptions;
  hover: number;
  /** Hovered node and its neighbours, when hovering. */
  highlighted: Uint8Array | null;
  /** The open note (local graph center or the active note), or -1. */
  focus: number;
}

const MAX_LABELS = 600;
const LABEL_FONT_PX = 12;

function truncate(label: string): string {
  return label.length > 48 ? label.slice(0, 46) + '…' : label;
}

export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame): void {
  const { width, height, dpr, transform: t, view, positions, radii, theme, display } = f;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  if (!positions || view.nodes.length === 0) return;

  const count = view.nodes.length;
  const k = t.k;
  const margin = 40 / k;
  const minX = -t.x / k - margin;
  const minY = -t.y / k - margin;
  const maxX = (width - t.x) / k + margin;
  const maxY = (height - t.y) / k + margin;
  const visible = (i: number) => {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    const r = radii[i]!;
    return x + r >= minX && x - r <= maxX && y + r >= minY && y - r <= maxY;
  };
  const hl = f.highlighted;
  const hovering = f.hover >= 0 && hl !== null;

  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * t.x, dpr * t.y);

  // ---------- links ----------
  const lineScreen = display.lineSizeMultiplier * Math.min(1.6, Math.max(0.5, Math.sqrt(k)));
  ctx.lineWidth = lineScreen / k;
  const links = view.links;
  const linkVisible = (a: number, b: number) => {
    const ax = positions[a * 2]!;
    const ay = positions[a * 2 + 1]!;
    const bx = positions[b * 2]!;
    const by = positions[b * 2 + 1]!;
    return !((ax < minX && bx < minX) || (ax > maxX && bx > maxX) || (ay < minY && by < minY) || (ay > maxY && by > maxY));
  };
  const strokeLinks = (want: (a: number, b: number) => boolean, color: string, alpha: number) => {
    ctx.beginPath();
    let any = false;
    for (let j = 0; j < links.length; j += 3) {
      const a = links[j]!;
      const b = links[j + 1]!;
      if (!want(a, b) || !linkVisible(a, b)) continue;
      ctx.moveTo(positions[a * 2]!, positions[a * 2 + 1]!);
      ctx.lineTo(positions[b * 2]!, positions[b * 2 + 1]!);
      any = true;
    }
    if (!any) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  if (hovering) {
    const h = f.hover;
    strokeLinks((a, b) => a !== h && b !== h, theme.line, 0.35);
    ctx.lineWidth = (lineScreen * 1.6) / k;
    strokeLinks((a, b) => a === h || b === h, theme.lineHighlight, 1);
    ctx.lineWidth = lineScreen / k;
  } else {
    strokeLinks(() => true, theme.line, 1);
  }

  // ---------- arrows ----------
  if (display.showArrow && k > 0.25) {
    const size = (lineScreen * 3 + 3) / k;
    const arrows = (want: (a: number, b: number) => boolean, color: string, alpha: number) => {
      ctx.beginPath();
      for (let j = 0; j < links.length; j += 3) {
        const a = links[j]!;
        const b = links[j + 1]!;
        const dir = links[j + 2]!;
        if (!want(a, b) || !linkVisible(a, b)) continue;
        if (dir & 1) arrowHead(ctx, positions, a, b, radii[b]!, size);
        if (dir & 2) arrowHead(ctx, positions, b, a, radii[a]!, size);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    if (hovering) {
      const h = f.hover;
      arrows((a, b) => a !== h && b !== h, theme.line, 0.6);
      arrows((a, b) => a === h || b === h, theme.lineHighlight, 1);
    } else {
      arrows(() => true, theme.line, 1);
    }
  }

  // ---------- nodes ----------
  const minRadius = 1.2 / k;
  for (const bucket of f.buckets) {
    for (const pass of hovering ? [0, 1] : [1]) {
      ctx.beginPath();
      let any = false;
      for (const i of bucket.nodes) {
        if (hovering && (hl![i] === 1) !== (pass === 1)) continue;
        if (!visible(i)) continue;
        const x = positions[i * 2]!;
        const y = positions[i * 2 + 1]!;
        const r = Math.max(radii[i]!, minRadius);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = pass === 0 ? 0.25 : 1;
      ctx.fillStyle = bucket.color;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  const ring = (i: number, color: string, width: number) => {
    if (i < 0 || i >= count) return;
    const r = Math.max(radii[i]!, minRadius);
    ctx.beginPath();
    ctx.arc(positions[i * 2]!, positions[i * 2 + 1]!, r + width / k, 0, Math.PI * 2);
    ctx.lineWidth = (width * 1.2) / k;
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  if (f.focus >= 0) {
    ctx.beginPath();
    const r = Math.max(radii[f.focus]!, minRadius);
    ctx.arc(positions[f.focus * 2]!, positions[f.focus * 2 + 1]!, r, 0, Math.PI * 2);
    ctx.fillStyle = theme.focused;
    ctx.fill();
  }
  if (f.hover >= 0) ring(f.hover, theme.focused, 2);

  // ---------- labels (screen space) ----------
  const fade = labelAlpha(k, display.textFadeMultiplier);
  const candidates: number[] = [];
  for (let i = 0; i < count; i++) {
    const always = i === f.hover || i === f.focus || (hovering && hl![i] === 1);
    if (!always && (fade <= 0.01 || hovering)) continue;
    if (!visible(i)) continue;
    candidates.push(i);
  }
  if (candidates.length > MAX_LABELS) {
    candidates.sort((a, b) => view.nodes[b]!.degree - view.nodes[a]!.degree);
    candidates.length = MAX_LABELS;
  }
  if (candidates.length === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `${LABEL_FONT_PX}px ${theme.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = theme.text;
  for (const i of candidates) {
    const always = i === f.hover || i === f.focus || (hovering && hl![i] === 1);
    ctx.globalAlpha = always ? 1 : fade;
    const sx = positions[i * 2]! * k + t.x;
    const sy = positions[i * 2 + 1]! * k + t.y + Math.max(radii[i]!, minRadius) * k + 3;
    ctx.fillText(truncate(view.nodes[i]!.label), sx, sy);
  }
  ctx.globalAlpha = 1;
}

function arrowHead(ctx: CanvasRenderingContext2D, p: Float32Array, from: number, to: number, toRadius: number, size: number): void {
  const fx = p[from * 2]!;
  const fy = p[from * 2 + 1]!;
  const tx = p[to * 2]!;
  const ty = p[to * 2 + 1]!;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < toRadius + size) return;
  const ux = dx / len;
  const uy = dy / len;
  const tipX = tx - ux * toRadius;
  const tipY = ty - uy * toRadius;
  const baseX = tipX - ux * size;
  const baseY = tipY - uy * size;
  const half = size * 0.5;
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX - uy * half, baseY + ux * half);
  ctx.lineTo(baseX + uy * half, baseY - ux * half);
  ctx.closePath();
}

/** The fill color of every node: its group color, else its type's color. */
export function nodeFills(view: ViewGraph, groups: readonly (string | null)[], theme: GraphTheme): string[] {
  return view.nodes.map((node, i) => {
    const group = groups[i];
    if (group) return group;
    switch (node.type) {
      case 'tag':
        return theme.tag;
      case 'attachment':
        return theme.attachment;
      case 'unresolved':
        return theme.unresolved;
      default:
        return theme.node;
    }
  });
}

/** Node indexes grouped by fill color, for one fill per color. */
export function bucketsOf(fills: readonly string[]): Array<{ color: string; nodes: Int32Array }> {
  const by = new Map<string, number[]>();
  fills.forEach((color, i) => {
    const list = by.get(color);
    if (list) list.push(i);
    else by.set(color, [i]);
  });
  return [...by].map(([color, nodes]) => ({ color, nodes: Int32Array.from(nodes) }));
}
