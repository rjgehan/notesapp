// The service worker's decisions, as pure functions (DESIGN §6.26): which requests it answers,
// how, and which caches it keeps. `sw.ts` wires them to the worker's events; the build plugin
// (vite-plugin-sw.ts) uses `precacheUrls`. Nothing here touches a browser global.

/** `/v/<name>` at the start of an extra vault's address (the rule of `vaultPath.ts`, DESIGN §6.44). */
const VAULT_PREFIX = /^\/v\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?(?=\/|$)/;

/** The raw-file endpoint of the default vault or of an extra one (`/api/v/<name>/files/raw`). */
const RAW_FILE = /^\/api(?:\/v\/[a-z0-9-]+)?\/files\/raw$/;

/** One cache per precache version; older ones are deleted when a new worker activates. */
export const SHELL_PREFIX = 'notesapp-shell-';
/** Content-addressed note images (`/api/files/raw?…&v=`), kept for offline reading. */
export const MEDIA_CACHE = 'notesapp-media';
/** The worker's own settings (whether note images are kept offline). */
export const CONFIG_CACHE = 'notesapp-config';
export const CONFIG_KEY = '/__notesapp/sw-config';
/** What another app shared, until the capture page has read it (features/sharedItems.ts). */
export const SHARE_CACHE = 'notesapp-share';
/** The installed app's share target (manifest `share_target.action`). */
export const SHARE_TARGET = '/capture/share';

export function shareKey(id: string): string {
  return `/__share/${encodeURIComponent(id)}`;
}

/** At most this many images; the oldest go first. */
export const MEDIA_MAX_ENTRIES = 300;
/** A navigation the network has not answered by then is served the cached app shell. */
export const NAVIGATION_TIMEOUT_MS = 4000;
/** The cached page every client route gets offline. */
export const SHELL_PAGE = '/index.html';

export function shellCacheName(version: string): string {
  return SHELL_PREFIX + version;
}

/** The app shell caches other than `current`, to delete on activation. */
export function staleShellCaches(names: readonly string[], current: string): string[] {
  return names.filter((n) => n.startsWith(SHELL_PREFIX) && n !== current);
}

/**
 * Client routes, exactly those the server answers with index.html (SpaController). Other
 * navigations (a raw file opened in a tab, `/api/…?download=true`) are never given the shell.
 * Nor is the web clipper's `/clip` (DESIGN §6.27.1): the server sends it without
 * Cross-Origin-Opener-Policy so the bookmarklet's page can post to it, and the cached shell
 * carries the app's `same-origin` policy, which would cut that window off.
 */
export function isSpaRoute(pathname: string): boolean {
  // An extra vault's app (DESIGN §6.44) has the same routes under /v/<name>.
  pathname = pathname.replace(VAULT_PREFIX, '') || '/';
  if (pathname === '/' || pathname === '/search' || pathname === '/trash' || pathname === '/settings' || pathname === '/capture') return true;
  return pathname.startsWith('/n/') || pathname.startsWith('/settings/') || pathname.startsWith('/x/');
}

/** Bundles under /assets/ carry a content hash in their name: the same URL is the same bytes. */
export function isHashedAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/');
}

/** Note images the reading view loads by a content-addressed URL (API.md §9.1). */
export function isContentAddressedImage(url: URL): boolean {
  return RAW_FILE.test(url.pathname) && url.searchParams.has('path') && url.searchParams.has('v') && !url.searchParams.has('download');
}

export interface RequestFacts {
  method: string;
  url: string;
  mode: string;
  destination: string;
  /** A `Range` header (audio and video): never answered from a cache. */
  hasRange: boolean;
}

export type Route = 'navigate' | 'shell' | 'media' | 'share' | 'network';

/**
 * How the worker answers a request. Everything not listed goes to the network untouched; in
 * particular the API (`no-store`, versioned, the conflict protocol) never comes from a cache.
 */
export function classify(req: RequestFacts, origin: string, precached: ReadonlySet<string>): Route {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return 'network';
  }
  if (url.origin !== origin) return 'network';
  // Another app shared something with the installed app (DESIGN §6.27): the worker keeps it.
  if (req.method === 'POST' && req.mode === 'navigate' && url.pathname === SHARE_TARGET) return 'share';
  if (req.method !== 'GET') return 'network';
  if (req.mode === 'navigate') return isSpaRoute(url.pathname) ? 'navigate' : 'network';
  if (req.hasRange) return 'network';
  if (url.search === '' && precached.has(url.pathname)) return 'shell';
  if (req.destination === 'image' && isContentAddressedImage(url)) return 'media';
  return 'network';
}

/**
 * A navigation answered with a gateway or server error (serve's empty 502 during a deploy, a 503
 * while the app starts) gets the cached shell: the app then runs offline until the server is back.
 */
export function shouldServeShellFor(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Excalidraw's self-hosted fonts (DESIGN §6.8.1): over 200 files and about 12 MB, mostly CJK subsets
 * that a drawing loads only for the characters it shows. They are left to the browser's HTTP cache,
 * which keeps the ones used (immutable, versioned path), rather than downloaded at every install.
 */
export function isExcalidrawFont(url: string): boolean {
  return /^\/assets\/excalidraw-[^/]+\/fonts\//.test(url);
}

/**
 * PDF.js's self-hosted assets (DESIGN §6.8.3): CMaps, standard fonts, WebAssembly decoders, colour
 * profiles and annotation icons, a few hundred files that a PDF loads only when it needs them. Like
 * Excalidraw's fonts they are left to the HTTP cache (immutable, versioned path).
 */
export function isPdfjsAsset(url: string): boolean {
  return /^\/assets\/pdfjs-[^/]+\//.test(url);
}

/**
 * A font's fallback format (KaTeX's CSS lists .woff and .ttf after .woff2): every browser the app
 * supports loads the .woff2, so precaching the others would only download about 0.8 MB for nothing.
 */
export function isLegacyFont(url: string): boolean {
  return /\.(?:ttf|woff|eot)$/i.test(url);
}

/**
 * The files the worker precaches: everything the build wrote except source maps, the worker itself,
 * Excalidraw's fonts, PDF.js's assets and fallback font formats.
 */
export function precacheUrls(files: readonly string[]): string[] {
  return files
    .map((f) => '/' + f.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((u) => !u.endsWith('.map') && u !== '/sw.js' && !u.startsWith('/.') && u !== '/robots.txt' && !isExcalidrawFont(u) && !isPdfjsAsset(u) && !isLegacyFont(u))
    .sort();
}

/** The oldest entries beyond `max` (Cache Storage keeps insertion order). */
export function overflow<T>(keys: readonly T[], max: number): T[] {
  return keys.length > max ? keys.slice(0, keys.length - max) : [];
}

/** Shown for a client route when neither the network nor a cached shell can answer. */
export const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Notes: offline</title><style>body{font:16px system-ui,sans-serif;background:#1e1e1e;color:#dadada;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}a{color:#a68af9}</style></head><body><main><h1>Can't reach NotesApp</h1><p>Is Tailscale connected?</p><p><a href="">Try again</a></p></main></body></html>`;
