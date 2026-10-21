// Graph view options (ROADMAP item 16, DESIGN §6.21). The names and ranges follow Obsidian's
// `.obsidian/graph.json`, so an imported vault's graph settings carry over (ROADMAP item 24).
// They are per-device preferences in localStorage, like the theme: the phone and the PC show the
// graph at different sizes.

export interface ColorGroup {
  query: string;
  /** '#rrggbb' */
  color: string;
}

export interface FilterOptions {
  /** Search filter (API.md §12.1 grammar, matched on names, paths, aliases and tags). */
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  /** "Existing files only": hide links to notes that do not exist. */
  hideUnresolved: boolean;
  showOrphans: boolean;
  /** Only notes in this folder ('' = every folder). */
  folder: string;
  /** Only notes with this tag or a nested one ('' = any). */
  tag: string;
}

export interface DisplayOptions {
  showArrow: boolean;
  /** -3 … 3: when labels appear while zooming (higher shows them sooner). */
  textFadeMultiplier: number;
  /** 0.1 … 5 */
  nodeSizeMultiplier: number;
  /** 0.1 … 5 */
  lineSizeMultiplier: number;
}

export interface ForceOptions {
  /** 0 … 1 */
  centerStrength: number;
  /** 0 … 20 */
  repelStrength: number;
  /** 0 … 1 */
  linkStrength: number;
  /** 30 … 500 */
  linkDistance: number;
}

export interface GraphOptions extends FilterOptions, DisplayOptions, ForceOptions {
  colorGroups: ColorGroup[];
}

export interface LocalGraphOptions extends GraphOptions {
  /** 1 … 5 links away from the open note. */
  depth: number;
  incoming: boolean;
  outgoing: boolean;
  /** Links between the open note's neighbours, not only to and from it. */
  neighborLinks: boolean;
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  search: '',
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
  folder: '',
  tag: '',
  colorGroups: [],
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  centerStrength: 0.52,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
};

export const DEFAULT_LOCAL_OPTIONS: LocalGraphOptions = {
  ...DEFAULT_GRAPH_OPTIONS,
  depth: 1,
  incoming: true,
  outgoing: true,
  neighborLinks: true,
};

export const RANGES = {
  textFadeMultiplier: [-3, 3, 0.1],
  nodeSizeMultiplier: [0.1, 5, 0.1],
  lineSizeMultiplier: [0.1, 5, 0.1],
  centerStrength: [0, 1, 0.01],
  repelStrength: [0, 20, 0.5],
  linkStrength: [0, 1, 0.01],
  linkDistance: [30, 500, 10],
  depth: [1, 5, 1],
} as const satisfies Record<string, readonly [number, number, number]>;

/** Colors offered for a new group, cycling. */
export const GROUP_PALETTE = ['#e05d6f', '#4fb3d9', '#b07fe8', '#e8885a', '#4cc9b0', '#e070c0', '#8fb3ff', '#c0c060'];

export const GRAPH_KEY = 'notesapp:graph';
export const LOCAL_GRAPH_KEY = 'notesapp:local-graph';

const HEX = /^#[0-9a-f]{6}$/i;

function num(v: unknown, fallback: number, [min, max]: readonly [number, number, number]): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function groups(v: unknown): ColorGroup[] {
  if (!Array.isArray(v)) return [];
  const out: ColorGroup[] = [];
  for (const g of v.slice(0, 50)) {
    if (g && typeof g === 'object') {
      const { query, color } = g as Record<string, unknown>;
      if (typeof query === 'string' && typeof color === 'string' && HEX.test(color)) out.push({ query, color: color.toLowerCase() });
    }
  }
  return out;
}

/** Options from untrusted JSON (localStorage), every field checked and clamped. */
export function sanitizeOptions(raw: unknown, defaults: GraphOptions = DEFAULT_GRAPH_OPTIONS): GraphOptions {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    search: str(r.search, defaults.search),
    showTags: bool(r.showTags, defaults.showTags),
    showAttachments: bool(r.showAttachments, defaults.showAttachments),
    hideUnresolved: bool(r.hideUnresolved, defaults.hideUnresolved),
    showOrphans: bool(r.showOrphans, defaults.showOrphans),
    folder: str(r.folder, defaults.folder),
    tag: str(r.tag, defaults.tag),
    colorGroups: r.colorGroups === undefined ? defaults.colorGroups : groups(r.colorGroups),
    showArrow: bool(r.showArrow, defaults.showArrow),
    textFadeMultiplier: num(r.textFadeMultiplier, defaults.textFadeMultiplier, RANGES.textFadeMultiplier),
    nodeSizeMultiplier: num(r.nodeSizeMultiplier, defaults.nodeSizeMultiplier, RANGES.nodeSizeMultiplier),
    lineSizeMultiplier: num(r.lineSizeMultiplier, defaults.lineSizeMultiplier, RANGES.lineSizeMultiplier),
    centerStrength: num(r.centerStrength, defaults.centerStrength, RANGES.centerStrength),
    repelStrength: num(r.repelStrength, defaults.repelStrength, RANGES.repelStrength),
    linkStrength: num(r.linkStrength, defaults.linkStrength, RANGES.linkStrength),
    linkDistance: num(r.linkDistance, defaults.linkDistance, RANGES.linkDistance),
  };
}

export function sanitizeLocalOptions(raw: unknown): LocalGraphOptions {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    ...sanitizeOptions(raw, DEFAULT_LOCAL_OPTIONS),
    depth: Math.round(num(r.depth, DEFAULT_LOCAL_OPTIONS.depth, RANGES.depth)),
    incoming: bool(r.incoming, true),
    outgoing: bool(r.outgoing, true),
    neighborLinks: bool(r.neighborLinks, true),
  };
}

export function loadOptions<T>(key: string, sanitize: (raw: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return sanitize(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitize({});
  }
}

export function saveOptions(key: string, options: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(options));
  } catch {
    // Private mode or quota: the options still apply to this page load.
  }
}

/** Obsidian stores a group color as {a, rgb} with rgb a 24-bit integer. */
export function obsidianColor(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null;
  const rgb = (c as Record<string, unknown>).rgb;
  if (typeof rgb !== 'number' || !Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff) return null;
  return '#' + rgb.toString(16).padStart(6, '0');
}

/**
 * The graph options of an Obsidian vault's `.obsidian/graph.json` (as the compatibility report
 * returns it, ROADMAP item 24) on top of `base`. Fields Obsidian does not have are kept.
 */
export function optionsFromObsidian(graph: Record<string, unknown>, base: GraphOptions = DEFAULT_GRAPH_OPTIONS): GraphOptions {
  const colorGroups: ColorGroup[] = [];
  if (Array.isArray(graph.colorGroups)) {
    for (const g of graph.colorGroups) {
      if (!g || typeof g !== 'object') continue;
      const { query, color } = g as Record<string, unknown>;
      const hex = typeof color === 'string' && HEX.test(color) ? color.toLowerCase() : obsidianColor(color);
      if (typeof query === 'string' && hex) colorGroups.push({ query, color: hex });
    }
  }
  return sanitizeOptions({ ...base, ...graph, colorGroups }, base);
}
