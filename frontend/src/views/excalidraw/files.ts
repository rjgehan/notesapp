// Images inside drawings (ROADMAP item 5, DESIGN §6.8.1) are vault attachments from the first
// version, as the Obsidian plugin stores them: `.excalidraw` is a text kind with the 5 MiB text
// limit, and base64 would put every photo into the JSON (and into a new git blob per autosave).
//
// - A pasted, dropped or picked image is uploaded with POST /api/attachments (source = the
//   drawing) before Excalidraw places it, and the scene's `files` entry stores its vault `path`
//   (an `.excalidraw.md` drawing lists it under `## Embedded Files` instead, as the plugin does).
// - On load each referenced attachment is fetched through /api/files/raw and handed to
//   Excalidraw as a data URL that lives in memory only.
// - Embedded data URLs from excalidraw.com files are kept as they are; one pasted in later is
//   kept when small, and moved to an attachment when it is over EMBED_LIMIT.
import type { DrawingFormat, SceneElement, StoredFile } from './format';

/** Embedded images up to this many data-URL characters stay in the file (about 256 KB). */
export const EMBED_LIMIT = 256 * 1024;

/** Excalidraw's DEFAULT_MAX_IMAGE_WIDTH_OR_HEIGHT: what it scales inserted images down to. */
export const MAX_IMAGE_DIMENSION = 1440;

/** A file as Excalidraw holds it in memory, plus the vault path when it is an attachment. */
export interface LiveFile {
  id: string;
  mimeType: string;
  dataURL?: string;
  created?: number;
  path?: string;
}

/** Where a referenced image comes from, as far as the file is concerned. */
export interface FileSources {
  /** The `files` entries of the loaded JSON, written back verbatim while still referenced. */
  stored: ReadonlyMap<string, StoredFile>;
  /** Images listed under `## Embedded Files` (Markdown drawings): never repeated in the JSON. */
  section: ReadonlySet<string>;
  /** Attachments uploaded or recognised during this session. */
  vault: ReadonlyMap<string, { path: string; mimeType: string; created: number }>;
}

export function referencedFileIds(elements: readonly SceneElement[]): string[] {
  const ids = new Set<string>();
  for (const e of elements) if (e.type === 'image' && !e.isDeleted && typeof e.fileId === 'string') ids.add(e.fileId);
  return [...ids];
}

/**
 * The `files` entries to write for `elements` (only referenced files, as Excalidraw exports),
 * and for a Markdown drawing the attachments that need an `## Embedded Files` entry.
 */
export function filesToStore(
  format: DrawingFormat,
  elements: readonly SceneElement[],
  live: Readonly<Record<string, LiveFile | undefined>>,
  sources: FileSources,
): { files: Record<string, StoredFile>; attachments: Array<{ id: string; path: string }> } {
  const files: Record<string, StoredFile> = {};
  const attachments: Array<{ id: string; path: string }> = [];
  for (const id of referencedFileIds(elements)) {
    if (format === 'markdown' && sources.section.has(id)) continue;
    const stored = sources.stored.get(id);
    if (stored && (stored.path || stored.dataURL)) {
      files[id] = stored;
      continue;
    }
    const file = live[id];
    const vault = sources.vault.get(id);
    const path = vault?.path ?? file?.path;
    if (path) {
      if (format === 'markdown') attachments.push({ id, path });
      else files[id] = { mimeType: vault?.mimeType ?? file?.mimeType ?? 'application/octet-stream', id, created: vault?.created ?? file?.created ?? Date.now(), path };
    } else if (file?.dataURL) {
      files[id] = { mimeType: file.mimeType, id, dataURL: file.dataURL, created: file.created ?? Date.now() };
    }
  }
  return { files, attachments };
}

// ---------- names and ids ----------

/** Clipboard images arrive as `image.png` (or nameless); those get the "Pasted image" name. */
export function isPastedName(name: string): boolean {
  return name === '' || /^image\.[a-z0-9]+$/i.test(name);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Excalidraw's own file id: the SHA-1 of the bytes, so the same image is stored once per drawing. */
export async function fileIdFor(blob: Blob): Promise<string> {
  try {
    return hex(await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()));
  } catch {
    // No SubtleCrypto (an insecure context): any unique id will do.
    return hex(crypto.getRandomValues(new Uint8Array(20)).buffer as ArrayBuffer);
  }
}

// ---------- data URLs ----------

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read'));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataURL: string): Blob {
  const comma = dataURL.indexOf(',');
  const header = dataURL.slice(5, comma);
  const type = header.split(';')[0] || 'application/octet-stream';
  const payload = dataURL.slice(comma + 1);
  if (header.endsWith(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  return new Blob([decodeURIComponent(payload)], { type });
}

/**
 * The in-memory image for an attachment: scaled down to what Excalidraw itself keeps for an
 * inserted image, so a few phone photos do not exhaust the iPhone's memory. The vault keeps the
 * original. SVG and GIF (animation) are used as they are.
 */
export async function displayDataUrl(blob: Blob): Promise<{ dataURL: string; mimeType: string }> {
  const original = async () => ({ dataURL: await blobToDataUrl(blob), mimeType: blob.type || 'application/octet-stream' });
  if (blob.type === 'image/svg+xml' || blob.type === 'image/gif' || typeof createImageBitmap !== 'function') return original();
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close();
      return original();
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const mimeType = blob.type === 'image/jpeg' || blob.type === 'image/webp' ? blob.type : 'image/png';
    const scaled = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.92));
    return scaled ? { dataURL: await blobToDataUrl(scaled), mimeType: scaled.type || mimeType } : original();
  } catch {
    return original();
  }
}
