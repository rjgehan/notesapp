// A drawing as a standalone SVG (ROADMAP item 5, DESIGN §6.8.1): what `![[drawing]]` embeds show,
// and what an Obsidian drawing that embeds another drawing shows in its place. Part of the lazy
// chunk that carries the Excalidraw package (exportToSvg).
//
// - Images come from images.ts, as in the editor: attachments are fetched, the plugin's extras
//   become static images.
// - Fonts: Excalidraw's own inlining subsets fonts with WebAssembly, which the CSP does not allow,
//   and its fallback (whole fonts) builds a string from one argument per byte, which Safari refuses
//   for fonts over 64 KB. So the SVG is exported without fonts, and the self-hosted font files of
//   the faces its texts use are inlined here as data URLs: an SVG shown as an image loads nothing.
// - Dark theme: Excalidraw inverts the exported SVG with a CSS filter on its root and counters it
//   on photos with another one, but filter functions on SVG elements are not reliable across
//   browsers. The root's filter moves to the <img> (`DARK_FILTER`), and the photos' to an SVG
//   <filter> made of the primitives the CSS functions are defined by.
import { exportToSvg } from '@excalidraw/excalidraw';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { referencedFileIds } from './files';
import { excalidrawFontFaces, keepFontsSameOrigin, type FontFaceRecord } from './fonts';
import { drawingFormat, parseDrawing } from './format';
import { imageBoxes, imageFor, type ImageEnv } from './images';

keepFontsSameOrigin();

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Excalidraw's THEME_FILTER, applied to the <img> showing a dark export. */
export const DARK_FILTER = 'invert(93%) hue-rotate(180deg)';

const IMAGE_FILTER_ID = 'notesapp-image-invert';

export type DrawingSvg = { kind: 'svg'; svg: string; width: number; height: number } | { kind: 'empty' } | { kind: 'unreadable'; message: string };

export interface DrawingSvgOptions {
  /** Export for the dark theme: show the result with `DARK_FILTER`. */
  dark: boolean;
  env: ImageEnv;
}

/** The drawing in `text` (the file at `path`, LF) as SVG markup. */
export async function renderDrawingSvg(path: string, text: string, opts: DrawingSvgOptions): Promise<DrawingSvg> {
  const parsed = parseDrawing(drawingFormat(path), text);
  if (!parsed.ok) return { kind: 'unreadable', message: parsed.message };
  const { scene, markdown } = parsed.drawing;
  const elements = scene.elements.filter((e) => !e.isDeleted);
  if (elements.length === 0) return { kind: 'empty' };

  const refs = { stored: new Map(Object.entries(scene.files)), section: new Map((markdown?.embedded ?? []).map((e) => [e.id, e.ref])) };
  const boxes = imageBoxes(elements);
  const files: Record<string, BinaryFileData> = {};
  await Promise.all(
    referencedFileIds(elements).map(async (id) => {
      const file = await imageFor(id, refs, opts.env, path, boxes.get(id));
      if (file?.dataURL) files[id] = { id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created ?? Date.now() } as unknown as BinaryFileData;
    }),
  );
  const background = typeof scene.appState.viewBackgroundColor === 'string' ? scene.appState.viewBackgroundColor : '#ffffff';
  const svg = await exportToSvg({
    elements: elements as never,
    appState: { exportBackground: true, viewBackgroundColor: background, exportWithDarkMode: opts.dark, exportEmbedScene: false },
    files,
    exportPadding: 10,
    skipInliningFonts: true,
  });
  moveThemeFilters(svg);
  const css = await fontFaceCss(usedFaces(svg, excalidrawFontFaces()));
  if (css) {
    let style = svg.querySelector('style.style-fonts');
    if (!style) {
      style = document.createElementNS(SVG_NS, 'style');
      (svg.querySelector('defs') ?? svg).appendChild(style);
    }
    style.textContent = css;
  }
  return {
    kind: 'svg',
    svg: new XMLSerializer().serializeToString(svg),
    width: Number(svg.getAttribute('width')) || 0,
    height: Number(svg.getAttribute('height')) || 0,
  };
}

// ---------- the dark theme ----------

function filterPrimitive(name: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Drops the root's theme filter (the <img> carries it) and turns the counter-filter Excalidraw
 * puts on photos, `invert(100%) hue-rotate(180deg) saturate(1.25)`, into an equivalent SVG filter.
 */
export function moveThemeFilters(svg: SVGSVGElement): void {
  svg.removeAttribute('filter');
  const filtered = [...svg.querySelectorAll('[filter]')].filter((el) => !el.getAttribute('filter')!.startsWith('url('));
  if (filtered.length === 0) return;
  const filter = filterPrimitive('filter', { id: IMAGE_FILTER_ID, 'color-interpolation-filters': 'sRGB' });
  const invert = filterPrimitive('feComponentTransfer', {});
  for (const channel of ['feFuncR', 'feFuncG', 'feFuncB']) invert.appendChild(filterPrimitive(channel, { type: 'table', tableValues: '1 0' }));
  filter.append(invert, filterPrimitive('feColorMatrix', { type: 'hueRotate', values: '180' }), filterPrimitive('feColorMatrix', { type: 'saturate', values: '1.25' }));
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.prepend(defs);
  }
  defs.appendChild(filter);
  for (const el of filtered) el.setAttribute('filter', `url(#${IMAGE_FILTER_ID})`);
}

// ---------- fonts ----------

/** `U+0-7F, U+A0-FF, U+1F??` as code point ranges. */
export function unicodeRanges(range: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const part of range.split(',')) {
    const m = /^\s*U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?\s*$/i.exec(part);
    if (!m) continue;
    if (m[1].includes('?')) out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)]);
    else out.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
  }
  return out;
}

function familyNames(fontFamily: string): string[] {
  return fontFamily
    .split(',')
    .map((f) => f.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase())
    .filter(Boolean);
}

/** The registered faces whose family a text of `svg` names and whose range covers one of its characters. */
export function usedFaces(svg: Element, faces: readonly FontFaceRecord[]): FontFaceRecord[] {
  const byFamily = new Map<string, Array<{ face: FontFaceRecord; ranges: Array<[number, number]> }>>();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    byFamily.set(key, [...(byFamily.get(key) ?? []), { face, ranges: unicodeRanges(face.unicodeRange) }]);
  }
  const used = new Set<FontFaceRecord>();
  for (const text of svg.querySelectorAll('text')) {
    const family = text.getAttribute('font-family') ?? text.closest('[font-family]')?.getAttribute('font-family') ?? '';
    const codePoints = Array.from(text.textContent ?? '', (c) => c.codePointAt(0)!);
    for (const name of familyNames(family)) {
      for (const { face, ranges } of byFamily.get(name) ?? []) {
        if (codePoints.some((cp) => ranges.some(([from, to]) => cp >= from && cp <= to))) used.add(face);
      }
    }
  }
  return [...used];
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // In slices: Safari refuses calls with more than 65536 arguments.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const fontData = new Map<string, Promise<string | null>>();

/** A self-hosted font file as a data URL, fetched once (the server caches it as immutable). */
function fontDataUrl(url: string): Promise<string | null> {
  let data = fontData.get(url);
  if (!data) {
    data = fetch(url, { cache: 'force-cache' })
      .then(async (r) => (r.ok ? `data:font/woff2;base64,${base64(await r.arrayBuffer())}` : null))
      .catch(() => null);
    fontData.set(url, data);
    // A failure is not remembered: the next export tries again.
    void data.then((d) => {
      if (d === null) fontData.delete(url);
    });
  }
  return data;
}

/** `@font-face` rules for `faces`, with their files inlined (faces that fail to load are left out). */
export async function fontFaceCss(faces: readonly FontFaceRecord[]): Promise<string> {
  const rules = await Promise.all(
    faces.map(async (face) => {
      const data = await fontDataUrl(face.url);
      if (!data) return null;
      const family = face.family.replace(/["\\]/g, '');
      const range = face.unicodeRange.replace(/[^Uu+0-9A-Fa-f?,\s-]/g, '');
      return `@font-face { font-family: "${family}"; src: url(${data}) format("woff2"); unicode-range: ${range}; }`;
    }),
  );
  return rules.filter((r): r is string => r !== null).join('\n');
}
