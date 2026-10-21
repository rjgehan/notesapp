// What another app shared with the installed app (Web Share Target, DESIGN §6.22). The service
// worker answers the share's POST itself: it keeps the title, text, URL and files in the Cache
// Storage cache `notesapp-share` under `/__share/<id>` and sends the browser to
// `/capture?share=<id>`, where the capture page reads them back with these helpers.
import { SHARE_CACHE, shareKey } from '../sw/core';
import type { SharedData } from './capture';

const MAX_AGE_MS = 24 * 3600 * 1000;

export interface SharedMeta extends SharedData {
  files: Array<{ name: string; type: string; key: string }>;
  at: number;
}

export interface SharedItem extends SharedData {
  files: File[];
}

function cacheStorage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

/** The shared item with this id, or null when it is gone (or never arrived). */
export async function readShared(id: string): Promise<SharedItem | null> {
  const storage = cacheStorage();
  if (!storage) return null;
  const cache = await storage.open(SHARE_CACHE);
  const res = await cache.match(shareKey(id));
  if (!res) return null;
  const meta = (await res.json()) as SharedMeta;
  const files: File[] = [];
  for (const f of meta.files) {
    const body = await cache.match(f.key);
    if (body) files.push(new File([await body.blob()], f.name, { type: f.type }));
  }
  return { title: meta.title ?? null, text: meta.text ?? null, url: meta.url ?? null, files };
}

/** Forgets a shared item (after it was captured or dismissed), and any older than a day. */
export async function forgetShared(id: string | null, now = Date.now()): Promise<void> {
  const storage = cacheStorage();
  if (!storage) return;
  const cache = await storage.open(SHARE_CACHE);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!/^\/__share\/[^/]+$/.test(path)) continue;
    const mine = id !== null && path === shareKey(id);
    let old = false;
    if (!mine) {
      const meta = (await (await cache.match(req))?.json().catch(() => null)) as SharedMeta | null;
      old = !meta || now - meta.at > MAX_AGE_MS;
    }
    if (!mine && !old) continue;
    const meta = (await (await cache.match(req))?.json().catch(() => null)) as SharedMeta | null;
    for (const f of meta?.files ?? []) await cache.delete(f.key);
    await cache.delete(req);
  }
}
