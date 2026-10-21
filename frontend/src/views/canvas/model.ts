// The JSON Canvas 1.0 data model (https://jsoncanvas.org/spec/1.0/, ROADMAP item 25): nodes and
// edges as the plain objects read from the file, so fields this app does not know (Obsidian's
// `styleAttributes`, a plugin's own keys) travel with them untouched. Documents are immutable: an
// edit builds new arrays and new objects for what it changes, and keeps the identity of the rest,
// which the serializer uses to write untouched parts back byte for byte (format.ts).

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';
export type NodeType = 'text' | 'file' | 'link' | 'group';

export interface CanvasNode {
  id: string;
  /** `text`, `file`, `link` or `group`; any other type is kept and drawn as a plain box. */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A preset `"1"`–`"6"` or a hex colour such as `"#ff0000"`. */
  color?: string;
  text?: string;
  file?: string;
  /** A heading or block in `file`, starting with `#`. */
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: string;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  /** Default `none`. */
  fromEnd?: CanvasEnd;
  /** Default `arrow`. */
  toEnd?: CanvasEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How a document was written, so that saving it changes no more bytes than the edit needs. */
export interface CanvasFormat {
  /**
   * `obsidian`: Obsidian's layout (tabs, one node or edge per line, no spaces); `pretty`:
   * `JSON.stringify(doc, null, indent)`; `compact`: everything on one line.
   */
  layout: 'obsidian' | 'pretty' | 'compact';
  indent: string;
  trailingNewline: boolean;
  /** Top-level keys in file order, `nodes` and `edges` included where they were present. */
  keys: readonly string[];
}

/** What a document was parsed from: the text and the parts it produced (by identity). */
export interface CanvasOrigin {
  text: string;
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  extra: ReadonlyMap<string, unknown>;
}

export interface CanvasDoc {
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  /** Top-level members other than `nodes` and `edges`, by key. */
  extra: ReadonlyMap<string, unknown>;
  format: CanvasFormat;
  origin: CanvasOrigin | null;
}

export const DEFAULT_FORMAT: CanvasFormat = { layout: 'obsidian', indent: '\t', trailingNewline: false, keys: ['nodes', 'edges'] };

export function emptyDoc(): CanvasDoc {
  return { nodes: [], edges: [], extra: new Map(), format: DEFAULT_FORMAT, origin: null };
}

// ---------- node accessors (files from elsewhere may hold anything) ----------

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 30;

export function nodeRect(n: CanvasNode): Rect {
  return {
    x: num(n.x, 0),
    y: num(n.y, 0),
    width: Math.max(1, num(n.width, 250)),
    height: Math.max(1, num(n.height, 60)),
  };
}

export function nodeText(n: CanvasNode): string {
  return typeof n.text === 'string' ? n.text : '';
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function edgeFromEnd(e: CanvasEdge): CanvasEnd {
  return e.fromEnd === 'arrow' ? 'arrow' : 'none';
}

export function edgeToEnd(e: CanvasEdge): CanvasEnd {
  return e.toEnd === 'none' ? 'none' : 'arrow';
}

export function isSide(v: unknown): v is CanvasSide {
  return v === 'top' || v === 'right' || v === 'bottom' || v === 'left';
}

/** The first lines of a card's Markdown as plain text, for zoomed-out views and previews. */
export function plainExcerpt(text: string, max = 160): string {
  const plain = text
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/!?\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m, t: string, d: string) => d || t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~=]{1,3}/g, '')
    .trim();
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

// ---------- colours ----------

/** The six presets (the spec leaves the exact values to apps; these are Obsidian's). */
export const PRESET_COLORS: Record<string, { name: string; value: string }> = {
  '1': { name: 'Red', value: '#fb464c' },
  '2': { name: 'Orange', value: '#e9973f' },
  '3': { name: 'Yellow', value: '#e0de71' },
  '4': { name: 'Green', value: '#44cf6e' },
  '5': { name: 'Cyan', value: '#53dfdd' },
  '6': { name: 'Purple', value: '#a882ff' },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A CSS colour for a canvas colour, or null for none (or a value that is not a colour). */
export function cssColor(color: unknown): string | null {
  if (typeof color !== 'string' || color === '') return null;
  const preset = PRESET_COLORS[color];
  if (preset) return preset.value;
  return HEX.test(color) ? color : null;
}

// ---------- ids ----------

/** A 16-digit hex id like Obsidian's, unique among `taken`. */
export function newId(taken?: { has(id: string): boolean }): string {
  for (;;) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    if (!taken || !taken.has(id)) return id;
  }
}

export function idSet(doc: Pick<CanvasDoc, 'nodes' | 'edges'>): Set<string> {
  const ids = new Set<string>();
  for (const n of doc.nodes) ids.add(n.id);
  for (const e of doc.edges) ids.add(e.id);
  return ids;
}

// ---------- geometry ----------

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function sideAnchor(r: Rect, side: CanvasSide): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.width / 2, y: r.y };
    case 'bottom':
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case 'left':
      return { x: r.x, y: r.y + r.height / 2 };
    case 'right':
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

const NORMALS: Record<CanvasSide, Point> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** The side of `r` facing `p` (relative to the rectangle's shape, so wide cards prefer top and bottom less). */
export function sideToward(r: Rect, p: Point): CanvasSide {
  const dx = (p.x - (r.x + r.width / 2)) / Math.max(1, r.width / 2);
  const dy = (p.y - (r.y + r.height / 2)) / Math.max(1, r.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export interface EdgeGeometry {
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
  /** The SVG path. */
  d: string;
  /** Where the label goes. */
  mid: Point;
}

/** A cubic Bézier from side to side, its control points pushed out along each side's normal. */
export function edgeGeometry(from: Rect, fromSide: CanvasSide | undefined, to: Rect, toSide: CanvasSide | undefined): EdgeGeometry {
  const fs = fromSide ?? sideToward(from, center(to));
  const ts = toSide ?? sideToward(to, center(from));
  const start = sideAnchor(from, fs);
  const end = sideAnchor(to, ts);
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const reach = Math.min(250, Math.max(40, dist * 0.4));
  const c1 = { x: start.x + NORMALS[fs].x * reach, y: start.y + NORMALS[fs].y * reach };
  const c2 = { x: end.x + NORMALS[ts].x * reach, y: end.y + NORMALS[ts].y * reach };
  const mid = bezierPoint(start, c1, c2, end, 0.5);
  const f = (n: number) => Math.round(n * 10) / 10;
  const d = `M${f(start.x)},${f(start.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(end.x)},${f(end.y)}`;
  return { start, end, c1, c2, d, mid };
}

/** A path to a free point (an edge being drawn). */
export function danglingGeometry(from: Rect, fromSide: CanvasSide, to: Point): EdgeGeometry {
  const start = sideAnchor(from, fromSide);
  const dist = Math.hypot(to.x - start.x, to.y - start.y);
  const reach = Math.min(250, Math.max(20, dist * 0.4));
  const c1 = { x: start.x + NORMALS[fromSide].x * reach, y: start.y + NORMALS[fromSide].y * reach };
  const c2 = { x: to.x, y: to.y };
  const mid = bezierPoint(start, c1, c2, to, 0.5);
  const d = `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`;
  return { start, end: to, c1, c2, d, mid };
}

export function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** The points of an arrowhead whose tip is `tip`, pointing away from `from`. */
export function arrowHead(tip: Point, from: Point, size: number): string {
  let dx = tip.x - from.x;
  let dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const bx = tip.x - dx * size;
  const by = tip.y - dy * size;
  const px = -dy * size * 0.5;
  const py = dx * size * 0.5;
  const f = (n: number) => Math.round(n * 10) / 10;
  return `${f(tip.x)},${f(tip.y)} ${f(bx + px)},${f(by + py)} ${f(bx - px)},${f(by - py)}`;
}

/** Distance from `p` to the edge's curve (sampled), for hit tests without the DOM. */
export function distanceToCurve(g: EdgeGeometry, p: Point, samples = 24): number {
  let best = Infinity;
  let prev = g.start;
  for (let i = 1; i <= samples; i++) {
    const cur = bezierPoint(g.start, g.c1, g.c2, g.end, i / samples);
    best = Math.min(best, distanceToSegment(p, prev, cur));
    prev = cur;
  }
  return best;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
