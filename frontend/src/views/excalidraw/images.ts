// What each image element of a drawing shows (ROADMAP item 5, DESIGN §6.8.1), for the editor
// (controller.ts) and for `![[drawing]]` embeds (svg.ts) alike: an embedded data URL as it is, a
// vault attachment fetched for display, and for an Obsidian drawing's `## Embedded Files` entries
// also the plugin's extras as static images (an embedded note or drawing, a LaTeX formula), or a
// placeholder for what the app does not show. Nothing here changes the file.
import { kindOfPath } from '../../features/fileKinds';
import type { LiveFile, Scaled } from './files';
import type { EmbeddedRef, SceneElement, StoredFile } from './format';
import { formulaCardSvg, placeholderDataUrl, svgDataUrl, type Box } from './statics';

/** Where a drawing's images come from. */
export interface ImageRefs {
  /** The JSON's `files` entries. */
  stored: ReadonlyMap<string, StoredFile>;
  /** `## Embedded Files` entries (Markdown drawings). */
  section: ReadonlyMap<string, EmbeddedRef>;
  /** Attachments uploaded during this session (the editor). */
  vault?: ReadonlyMap<string, { path: string }>;
}

/** An image for Excalidraw, and how much a large attachment was scaled down for display. */
export interface LoadedFile extends LiveFile {
  scaled?: Scaled;
}

/** The app services images need (DrawingEnv's). */
export interface ImageEnv {
  /**
   * An attachment for display (scaled down when large, unless `fullSize`), or null when it is not
   * in the vault.
   */
  loadAttachment(path: string, source: string, opts?: { fullSize?: boolean }): Promise<{ dataURL: string; mimeType: string; path: string; scaled?: Scaled } | null>;
  resolveLink(target: string, source: string): string | null;
  /**
   * A vault file that is not an image, embedded the Obsidian plugin's way (a note or a section of
   * one, another drawing), as a static image of about `box`; null when it has none.
   */
  embeddedFile?(path: string, subpath: string | null, source: string, box: Box | undefined): Promise<{ dataURL: string; mimeType: string } | null>;
}

/** The size of the first image element showing each file (an embedded note's card fills it). */
export function imageBoxes(elements: readonly SceneElement[]): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const e of elements) {
    if (e.type !== 'image' || e.isDeleted || typeof e.fileId !== 'string' || boxes.has(e.fileId)) continue;
    const width = typeof e.width === 'number' ? Math.abs(e.width) : 0;
    const height = typeof e.height === 'number' ? Math.abs(e.height) : 0;
    if (width > 0 && height > 0) boxes.set(e.fileId, { width, height });
  }
  return boxes;
}

function staticImage(id: string, svg: string): LiveFile {
  return { id, mimeType: 'image/svg+xml', dataURL: svgDataUrl(svg), created: Date.now() };
}

function placeholder(id: string, label: string, detail: string): LiveFile {
  return { id, mimeType: 'image/svg+xml', dataURL: placeholderDataUrl(label, detail), created: Date.now() };
}

async function attachment(id: string, path: string, env: ImageEnv, source: string, fullSize: boolean): Promise<LoadedFile> {
  try {
    const loaded = await (fullSize ? env.loadAttachment(path, source, { fullSize }) : env.loadAttachment(path, source));
    if (loaded) return { id, mimeType: loaded.mimeType, dataURL: loaded.dataURL, created: Date.now(), path: loaded.path, ...(loaded.scaled ? { scaled: loaded.scaled } : {}) };
  } catch {
    // Shown as missing; the file keeps its reference.
  }
  return placeholder(id, 'Missing image', path);
}

/** A `data:` URL, the only kind of image a drawing's file may carry inline. */
export function isDataUrl(url: string): boolean {
  return /^data:/i.test(url);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The image for file `id` of the drawing at `source`, or null when nothing references it.
 * `fullSize` loads an attachment as it is (an image element crops it, in its own pixels).
 */
export async function imageFor(id: string, refs: ImageRefs, env: ImageEnv, source: string, box?: Box, fullSize = false): Promise<LoadedFile | null> {
  const stored = refs.stored.get(id);
  if (stored?.dataURL) {
    // Only embedded data: a URL in its place is never fetched (a web image, a tracker).
    if (isDataUrl(stored.dataURL)) return { id, mimeType: stored.mimeType, dataURL: stored.dataURL, created: stored.created };
    return placeholder(id, 'Web image (not loaded here)', stored.dataURL.slice(0, 200));
  }
  const path = stored?.path ?? refs.vault?.get(id)?.path;
  if (path) return attachment(id, path, env, source, fullSize);
  const ref = refs.section.get(id);
  if (!ref) return null;
  switch (ref.kind) {
    case 'link': {
      const resolved = env.resolveLink(ref.target, source);
      if (!resolved) return placeholder(id, 'Missing image', ref.target);
      if (kindOfPath(resolved) === 'image') return attachment(id, resolved, env, source, fullSize);
      try {
        const shown = await env.embeddedFile?.(resolved, ref.subpath ?? null, source, box);
        if (shown) return { id, ...shown, created: Date.now() };
      } catch {
        // A placeholder instead.
      }
      return placeholder(id, kindOfPath(resolved) === 'pdf' ? 'PDF page (shown in Obsidian)' : 'Embedded file (shown in Obsidian)', nameOf(resolved));
    }
    case 'latex':
      return staticImage(id, formulaCardSvg(ref.latex, box));
    case 'url':
      return placeholder(id, 'Web image (not loaded here)', ref.url);
    default:
      return placeholder(id, 'Embedded file (shown in Obsidian)', id);
  }
}
