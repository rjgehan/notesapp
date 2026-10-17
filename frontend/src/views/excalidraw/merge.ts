// Three-way merge of two versions of a drawing (ROADMAP item 5, DESIGN §6.8.1), the view's
// `merge()` hook: the session's `baseText` is the common ancestor, so an element one side never
// touched takes the other side's change (or deletion), and an element both sides changed is
// settled the way Excalidraw reconciles collaborators: the higher `version` wins, and on a tie
// the lower `versionNonce`. Returns null when the files cannot be merged (unparseable, or both
// sides changed the Markdown around the drawing differently): the conflict banner takes over.
import {
  isLiveText,
  markdownRest,
  parseDrawing,
  sceneJson,
  writeDrawing,
  type Drawing,
  type DrawingFormat,
  type Scene,
  type SceneElement,
  type StoredFile,
} from './format';

type Side = 'mine' | 'theirs';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** Bookkeeping that changes without the element changing (rawText mirrors the Markdown section). */
const VOLATILE = new Set(['version', 'versionNonce', 'updated', 'rawText']);

/**
 * True when `side` holds no change to `base`. A fractional `index` that `base` lacked is not a
 * change: Excalidraw assigns one (and bumps the version) when it opens an older file.
 */
export function unchanged(side: SceneElement, base: SceneElement): boolean {
  const ignoreIndex = typeof base.index !== 'string';
  const keys = new Set([...Object.keys(side), ...Object.keys(base)]);
  for (const k of keys) {
    if (VOLATILE.has(k) || (ignoreIndex && k === 'index')) continue;
    if (!deepEqual(side[k], base[k])) return false;
  }
  return true;
}

/** Excalidraw's reconciliation order: the higher version, then the lower versionNonce. */
function prefer(mine: SceneElement, theirs: SceneElement): Side {
  if (mine.version !== theirs.version) return mine.version > theirs.version ? 'mine' : 'theirs';
  return mine.versionNonce <= theirs.versionNonce ? 'mine' : 'theirs';
}

export interface MergedElements {
  elements: SceneElement[];
  /** Which side each surviving element came from. */
  from: Map<string, Side>;
}

export function mergeElements(base: readonly SceneElement[], mine: readonly SceneElement[], theirs: readonly SceneElement[]): MergedElements {
  const b = new Map(base.map((e) => [e.id, e]));
  const m = new Map(mine.map((e) => [e.id, e]));
  const t = new Map(theirs.map((e) => [e.id, e]));

  // Z-order: mine's order, with elements only theirs has placed after their predecessor there
  // (and after mine's own additions that follow it).
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const e of theirs) {
    if (m.has(e.id)) anchor = e.id;
    else after.set(anchor, [...(after.get(anchor) ?? []), e.id]);
  }
  const order: string[] = [];
  let pending = after.get(null) ?? [];
  for (const e of mine) {
    if (t.has(e.id)) {
      order.push(...pending);
      pending = [];
    }
    order.push(e.id);
    pending = [...pending, ...(after.get(e.id) ?? [])];
  }
  order.push(...pending);

  const from = new Map<string, Side>();
  const elements: SceneElement[] = [];
  for (const id of order) {
    const base = b.get(id);
    const mineEl = m.get(id);
    const theirsEl = t.get(id);
    let side: Side | null;
    if (mineEl && theirsEl) {
      if (deepEqual(mineEl, theirsEl)) side = 'mine';
      else if (base && unchanged(mineEl, base)) side = 'theirs';
      else if (base && unchanged(theirsEl, base)) side = 'mine';
      else side = prefer(mineEl, theirsEl);
    } else if (mineEl) {
      // Gone from theirs: deleted there, unless mine added it or changed it since (an edit wins).
      side = !base || !unchanged(mineEl, base) ? 'mine' : null;
    } else {
      side = !base || !unchanged(theirsEl!, base) ? 'theirs' : null;
    }
    if (!side) continue;
    let element = side === 'mine' ? mineEl! : theirsEl!;
    if (element.isDeleted) continue;
    // Both changed it: a link that only the other side changed (a rename rewrote it there) stays.
    const other = side === 'mine' ? theirsEl : mineEl;
    if (base && other && deepEqual(element.link, base.link) && !deepEqual(other.link, base.link)) element = { ...element, link: other.link };
    elements.push(element);
    from.set(id, side);
  }
  // Fractional indices, when every element has one, are the z-order both sides agree on.
  if (elements.every((e) => typeof e.index === 'string')) {
    const pos = new Map(elements.map((e, i) => [e.id, i]));
    elements.sort((x, y) => (x.index! < y.index! ? -1 : x.index! > y.index! ? 1 : pos.get(x.id)! - pos.get(y.id)!));
  }
  return { elements, from };
}

/** Per key: theirs wins where only theirs changed it. */
export function mergeAppState(base: Record<string, unknown>, mine: Record<string, unknown>, theirs: Record<string, unknown>): Record<string, unknown> {
  const out = { ...mine };
  for (const k of new Set([...Object.keys(base), ...Object.keys(theirs)])) {
    if (deepEqual(mine[k], base[k]) && !deepEqual(theirs[k], base[k])) {
      if (theirs[k] === undefined) delete out[k];
      else out[k] = theirs[k];
    }
  }
  return out;
}

export function mergeScenes(base: Scene, mine: Scene, theirs: Scene): { scene: Scene; from: Map<string, Side> } {
  const { elements, from } = mergeElements(base.elements, mine.elements, theirs.elements);
  const used = new Set(elements.filter((e) => e.type === 'image' && typeof e.fileId === 'string').map((e) => e.fileId as string));
  const files: Record<string, StoredFile> = {};
  for (const [id, f] of [...Object.entries(theirs.files), ...Object.entries(mine.files)]) if (used.has(id)) files[id] = f;
  return {
    scene: { ...theirs, ...mine, elements, appState: mergeAppState(base.appState, mine.appState, theirs.appState), files },
    from,
  };
}

function parse(format: DrawingFormat, text: string): Drawing | null {
  const r = parseDrawing(format, text);
  return r.ok ? r.drawing : null;
}

/** The descriptor's `merge(base, mine, theirs)` for one file format; null falls back to the banner. */
export function mergeDrawingTexts(format: DrawingFormat, baseText: string, mineText: string, theirsText: string): string | null {
  const base = parse(format, baseText);
  const mine = parse(format, mineText);
  const theirs = parse(format, theirsText);
  if (!base || !mine || !theirs) return null;
  const { scene, from } = mergeScenes(base.scene, mine.scene, theirs.scene);
  if (format === 'excalidraw' || !base.markdown || !mine.markdown || !theirs.markdown) return sceneJson('excalidraw', scene);

  // The Markdown around the drawing: one side's change, or the same change on both.
  const restBase = markdownRest(base.markdown);
  const restMine = markdownRest(mine.markdown);
  const restTheirs = markdownRest(theirs.markdown);
  let container: Drawing;
  if (restMine === restBase || restMine === restTheirs) container = theirs;
  else if (restTheirs === restBase) container = mine;
  else return null;
  const other = container === theirs ? mine : theirs;

  const texts = { mine: new Map(mine.markdown.texts.map((e) => [e.id, e.raw])), theirs: new Map(theirs.markdown.texts.map((e) => [e.id, e.raw])) };
  const originals = {
    mine: new Map(mine.scene.elements.filter(isLiveText).map((e) => [e.id, e.originalText])),
    theirs: new Map(theirs.scene.elements.filter(isLiveText).map((e) => [e.id, e.originalText])),
  };
  const baseTexts = new Map(base.markdown.texts.map((e) => [e.id, e.raw]));
  /** A side's Markdown source of `e`, while its text is the one that side has. */
  const sourceOf = (side: Side, e: SceneElement) => (originals[side].get(e.id) === e.originalText ? texts[side].get(e.id) : undefined);
  return writeDrawing(container, scene, {
    // Each text keeps the Markdown source of the side its element came from, unless only the
    // other side changed that source (a rename rewrote a link in it).
    rawText: (e) => {
      const side = from.get(e.id);
      if (!side) return undefined;
      const own = sourceOf(side, e);
      const other = sourceOf(side === 'mine' ? 'theirs' : 'mine', e);
      return own !== undefined && own === baseTexts.get(e.id) && other !== undefined && other !== own ? other : own;
    },
    addEmbedded: other.markdown!.embedded.map((e) => ({ id: e.id, value: e.value })),
  });
}

