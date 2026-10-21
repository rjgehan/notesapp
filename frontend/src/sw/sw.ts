// The service worker (DESIGN §6.21). Built by vite-plugin-sw.ts into dist/sw.js as one classic
// script, with the build's precache list and version compiled in.
//
// - Install precaches the app shell and every lazy chunk (hashed bundles still in an older shell
//   cache are copied, not downloaded again), then takes over at once: navigations are network-first,
//   so a page reloaded after a deploy gets the new index.html whichever worker is active.
// - Client-route navigations: network first; the cached shell when offline, after 4 s without an
//   answer, or on a gateway error (serve's 502 during a deploy). Other navigations are untouched.
// - Precached files: from the shell cache. Note images with a content-addressed URL: cache first,
//   at most 300 (switched off with the device's offline preference).
// - The API is never answered from a cache; offline reading of notes is the app's own IndexedDB
//   copy (src/offline), which knows how old it is.
import {
  classify,
  CONFIG_CACHE,
  CONFIG_KEY,
  isHashedAsset,
  MEDIA_CACHE,
  MEDIA_MAX_ENTRIES,
  NAVIGATION_TIMEOUT_MS,
  OFFLINE_PAGE,
  overflow,
  SHELL_PAGE,
  SHELL_PREFIX,
  shellCacheName,
  shouldServeShellFor,
  staleShellCaches,
} from './core';

declare const self: ServiceWorkerGlobalScope;
declare const __SW_BUILD__: string;
declare const __SW_VERSION__: string;
declare const __SW_PRECACHE__: string[];

const SHELL = shellCacheName(__SW_VERSION__);
const PRECACHE: ReadonlySet<string> = new Set(__SW_PRECACHE__);
const CONCURRENCY = 8;

// ---------- install and activate ----------

async function copyFromOlderShell(url: string, older: string[]): Promise<Response | null> {
  for (const name of older) {
    const hit = await (await caches.open(name)).match(url);
    if (hit) return hit;
  }
  return null;
}

async function precache(): Promise<void> {
  const cache = await caches.open(SHELL);
  const older = (await caches.keys()).filter((n) => n.startsWith(SHELL_PREFIX) && n !== SHELL);
  const queue = [...PRECACHE];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (await cache.match(url)) continue;
      const reused = isHashedAsset(url) ? await copyFromOlderShell(url, older) : null;
      if (reused) {
        await cache.put(url, reused);
        continue;
      }
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      // Any failure fails the install: the previous worker and its complete shell stay in charge.
      if (!res.ok || res.redirected) throw new Error(`Precaching ${url} failed: HTTP ${res.status}`);
      await cache.put(url, res);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const stale = staleShellCaches(await caches.keys(), SHELL);
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// ---------- requests ----------

async function shellResponse(path: string): Promise<Response | undefined> {
  return caches.match(path, { cacheName: SHELL });
}

function offlinePage(): Response {
  return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function navigate(request: Request): Promise<Response> {
  const network = fetch(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), NAVIGATION_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout' && !shouldServeShellFor(first.status)) return first;
    const shell = await shellResponse(SHELL_PAGE);
    if (shell) return shell;
    // No shell yet (first visit still installing): keep waiting for the network.
    return first === 'timeout' ? await network : first;
  } catch {
    return (await shellResponse(SHELL_PAGE)) ?? offlinePage();
  } finally {
    clearTimeout(timer);
    // The network answer that lost the race is not needed; keep it from surfacing as an error.
    network.catch(() => undefined);
  }
}

async function fromShell(request: Request): Promise<Response> {
  return (await shellResponse(new URL(request.url).pathname)) ?? fetch(request);
}

// ---------- note images ----------

let mediaEnabled: Promise<boolean> | null = null;

function isMediaEnabled(): Promise<boolean> {
  mediaEnabled ??= caches
    .open(CONFIG_CACHE)
    .then((c) => c.match(CONFIG_KEY))
    .then(async (res) => (res ? ((await res.json()) as { media?: boolean }).media !== false : true))
    .catch(() => true);
  return mediaEnabled;
}

async function setMediaEnabled(enabled: boolean): Promise<void> {
  mediaEnabled = Promise.resolve(enabled);
  const config = await caches.open(CONFIG_CACHE);
  await config.put(CONFIG_KEY, new Response(JSON.stringify({ media: enabled }), { headers: { 'Content-Type': 'application/json' } }));
  if (!enabled) await caches.delete(MEDIA_CACHE);
}

async function trimMedia(cache: Cache): Promise<void> {
  for (const key of overflow(await cache.keys(), MEDIA_MAX_ENTRIES)) await cache.delete(key);
}

async function media(event: FetchEvent): Promise<Response> {
  const request = event.request;
  if (!(await isMediaEnabled())) return fetch(request);
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200 && res.type === 'basic') {
    event.waitUntil(cache.put(request, res.clone()).then(() => trimMedia(cache)).catch(() => undefined));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const route = classify(
    { method: request.method, url: request.url, mode: request.mode, destination: request.destination, hasRange: request.headers.has('range') },
    self.location.origin,
    PRECACHE,
  );
  if (route === 'navigate') event.respondWith(navigate(request));
  else if (route === 'shell') event.respondWith(fromShell(request));
  else if (route === 'media') event.respondWith(media(event));
});

// ---------- messages from pages ----------

type PageMessage = { type: 'GET_VERSION' } | { type: 'SET_OFFLINE_MEDIA'; enabled: boolean };

self.addEventListener('message', (event) => {
  const message = event.data as PageMessage | null;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ build: __SW_BUILD__, version: __SW_VERSION__ });
  } else if (message.type === 'SET_OFFLINE_MEDIA') {
    event.waitUntil(setMediaEnabled(message.enabled === true));
  }
});
