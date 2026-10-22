// Web clipper, the app's side (DESIGN §6.27.1). The bookmarklet and the browser extension never
// call the API: they open /clip and hand it the clip with postMessage, and this page saves it
// through the ordinary same-origin API (POST /api/attachments, then POST /api/files), so the CSRF
// rules of API.md §2 apply unchanged. The extraction code is the clipper's own build
// (`clipper/`), served at /clipper/clipper.js and loaded on demand.
import type { AttachmentResult, WriteResult } from '../api/types';

export const READY_MESSAGE = 'notesapp-clip-ready';
export const CLIP_MESSAGE = 'notesapp-clip';
export const RESULT_MESSAGE = 'notesapp-clip-result';

/** The clipper build's script for this page (the Dockerfile copies `clipper/dist/web` there). */
export const CLIPPER_SCRIPT = '/clipper/clipper.js';

/** The page's HTML a bookmarklet may send (a long article with inline styles is a few MB). */
export const MAX_HTML_CHARS = 30_000_000;

/** The Markdown of a clip: the note's own size limit applies on the server too. */
export const MAX_MARKDOWN_CHARS = 5_000_000;

export const MAX_IMAGES = 40;

/** A clip, as `clipper/src/core/types.ts` defines it. */
export interface Clip {
  title: string;
  url: string;
  author: string | null;
  siteName: string | null;
  published: string | null;
  description: string | null;
  markdown: string;
  images: string[];
  selection: boolean;
}

export interface ClipImage {
  url: string;
  name: string;
  type: string;
  data: string;
}

export interface CreateClipRequest {
  path: string;
  content: string;
  onConflict: 'rename';
}

/** What /clipper/clipper.js puts on `window.NotesClipper`. */
export interface NotesClipper {
  version: number;
  defaultFolder: string;
  extractHtml(html: string, url: string, options?: { selectionHtml?: string | null }): Clip;
  composeNote(clip: Clip, options?: { folder?: string; basename?: string; created?: string }): CreateClipRequest;
  noteBasename(title: string): string;
  notePath(folder: string, basename: string): string;
  replaceImage(markdown: string, url: string, embed: string): string;
  localDate(d?: Date): string;
}

/** Where a clip came from: the bookmarklet (any web page: shown, saved only on Save) or the extension. */
export type ClipSource = 'bookmarklet' | 'extension' | 'paste';

export type ReceivedClip =
  | { source: ClipSource; kind: 'html'; url: string; title: string; html: string; selectionHtml: string }
  | { source: 'extension'; kind: 'clip'; clip: Clip; images: ClipImage[]; folder: string | null; autoSave: boolean };

function isString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

function isHttpUrl(v: unknown): v is string {
  if (!isString(v, 8192)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function nullableString(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return isString(v, max) ? v : undefined;
}

function validClip(v: unknown): Clip | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (!isString(c.title, 2000) || !isHttpUrl(c.url) || !isString(c.markdown, MAX_MARKDOWN_CHARS)) return null;
  const author = nullableString(c.author, 1000);
  const siteName = nullableString(c.siteName, 1000);
  const published = nullableString(c.published, 200);
  const description = nullableString(c.description, 5000);
  if (author === undefined || siteName === undefined || published === undefined || description === undefined) return null;
  if (!Array.isArray(c.images) || c.images.length > 500 || !c.images.every(isHttpUrl)) return null;
  return { title: c.title, url: c.url, author, siteName, published, description, markdown: c.markdown, images: c.images, selection: c.selection === true };
}

function validImage(v: unknown): ClipImage | null {
  if (!v || typeof v !== 'object') return null;
  const i = v as Record<string, unknown>;
  if (!isHttpUrl(i.url) || !isString(i.name, 300) || !isString(i.type, 100) || !i.type.startsWith('image/') || !isString(i.data, 15_000_000)) return null;
  return { url: i.url, name: i.name, type: i.type, data: i.data };
}

/**
 * A message from the bookmarklet or the extension, checked field by field (it comes from another
 * page), or null. `fromApp` is true for a message from this page's own origin: only the extension's
 * content script (or the app itself) can send one, so only those may skip the preview.
 */
export function parseClipMessage(data: unknown, fromApp: boolean): ReceivedClip | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.type !== CLIP_MESSAGE || m.v !== 1) return null;
  if (m.kind === 'html') {
    if (!isHttpUrl(m.url) || !isString(m.title, 2000) || !isString(m.html, MAX_HTML_CHARS) || !isString(m.selectionHtml, MAX_HTML_CHARS)) return null;
    return { source: fromApp ? 'extension' : 'bookmarklet', kind: 'html', url: m.url, title: m.title, html: m.html, selectionHtml: m.selectionHtml };
  }
  if (m.kind === 'clip' && fromApp) {
    const clip = validClip(m.clip);
    if (!clip || !Array.isArray(m.images) || m.images.length > MAX_IMAGES) return null;
    const images = m.images.map(validImage);
    if (images.some((i) => i === null)) return null;
    const folder = isString(m.folder, 1000) ? m.folder : null;
    return { source: 'extension', kind: 'clip', clip, images: images as ClipImage[], folder, autoSave: m.autoSave === true };
  }
  return null;
}

/** The page's address and title the bookmarklet put in the fragment, for the paste fallback. */
export function fragmentInfo(hash: string): { url: string; title: string } | null {
  if (!hash || hash === '#') return null;
  try {
    const v = JSON.parse(decodeURIComponent(hash.replace(/^#/, ''))) as Record<string, unknown>;
    return isHttpUrl(v.url) ? { url: v.url, title: isString(v.title, 2000) ? v.title : '' } : null;
  } catch {
    return null;
  }
}

let loading: Promise<NotesClipper> | null = null;

/** Loads /clipper/clipper.js once (same origin, so the CSP's `script-src 'self'` allows it). */
export function loadClipper(): Promise<NotesClipper> {
  const existing = (window as unknown as { NotesClipper?: NotesClipper }).NotesClipper;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<NotesClipper>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CLIPPER_SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { NotesClipper?: NotesClipper }).NotesClipper;
      if (api) resolve(api);
      else reject(new Error('The clipper script did not load'));
    };
    script.onerror = () => reject(new Error('This server has no clipper build (/clipper/clipper.js)'));
    document.head.appendChild(script);
  }).catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The clip a received message describes (the bookmarklet's HTML is extracted here). */
export function toClip(received: ReceivedClip, clipper: NotesClipper): Clip {
  if (received.kind === 'clip') return received.clip;
  const clip = clipper.extractHtml(received.html, received.url, { selectionHtml: received.selectionHtml || null });
  return clip.title ? clip : { ...clip, title: received.title };
}

/** Tells the bookmarklet (our opener) and the extension (a content script here) that we can receive. */
export function announceReady(win: Window = window): void {
  win.document.documentElement.dataset.notesappClip = 'ready';
  win.postMessage({ type: READY_MESSAGE }, win.location.origin);
  // The opener is whichever page ran the bookmarklet; the message tells it nothing but "ready".
  if (win.opener && win.opener !== win) (win.opener as Window).postMessage({ type: READY_MESSAGE }, '*');
}

/** Tells the extension what became of its clip. */
export function announceResult(result: { status: 'saved' | 'failed'; path?: string; error?: string }, win: Window = window): void {
  win.postMessage({ type: RESULT_MESSAGE, ...result }, win.location.origin);
}

export function base64Blob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export interface ClipApi {
  uploadAttachment(name: string, source: string | null, body: Blob, opts?: { idempotencyKey?: string }): Promise<AttachmentResult>;
  createFile(req: CreateClipRequest, opts?: { idempotencyKey?: string }): Promise<WriteResult>;
}

export interface SaveOptions {
  folder: string;
  basename: string;
  /** `YYYY-MM-DD` on this device. */
  created: string;
  newKey(): string;
}

/**
 * Saves a clip: each downloaded image first, as an attachment of the note-to-be (its folder comes
 * from the attachment settings, API.md §9.3), its Markdown pointed at the attachment, then the note
 * itself with `onConflict: "rename"`. An image that fails to upload stays a link to the web.
 */
export async function saveClip(clip: Clip, images: ClipImage[], options: SaveOptions, clipper: NotesClipper, api: ClipApi): Promise<WriteResult> {
  const planned = clipper.composeNote(clip, { folder: options.folder, basename: options.basename, created: options.created });
  let markdown = clip.markdown;
  for (const image of images) {
    try {
      const uploaded = await api.uploadAttachment(image.name, planned.path, base64Blob(image.data, image.type), { idempotencyKey: options.newKey() });
      markdown = clipper.replaceImage(markdown, image.url, uploaded.markdown);
    } catch {
      // Left as a link.
    }
  }
  const req = markdown === clip.markdown ? planned : clipper.composeNote({ ...clip, markdown }, { folder: options.folder, basename: options.basename, created: options.created });
  return api.createFile(req, { idempotencyKey: options.newKey() });
}

/** In the built bookmarklet, the app's origin is this placeholder (clipper/src/web/bookmarklet.ts). */
export const ORIGIN_PLACEHOLDER = '__NOTESAPP_ORIGIN__';

/** The bookmarklet for this origin: the placeholder sits inside a string, in a percent-encoded URL. */
export function bookmarkletFor(template: string, origin: string): string | null {
  if (!template.startsWith('javascript:') || !template.includes(ORIGIN_PLACEHOLDER)) return null;
  return template.split(ORIGIN_PLACEHOLDER).join(encodeURIComponent(origin));
}
