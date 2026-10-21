import { describe, expect, it } from 'vitest';
import { classify, isSpaRoute, overflow, precacheUrls, shellCacheName, shouldServeShellFor, staleShellCaches, type RequestFacts } from './core';

const ORIGIN = 'https://notes.example.ts.net';
const PRECACHED = new Set(['/index.html', '/assets/index-abc.js', '/theme-boot.js', '/manifest.webmanifest']);

function req(path: string, extra: Partial<RequestFacts> = {}): RequestFacts {
  return { method: 'GET', url: ORIGIN + path, mode: 'cors', destination: '', hasRange: false, ...extra };
}

describe('service worker routing', () => {
  it('serves client-route navigations network-first with the shell as fallback', () => {
    for (const path of ['/', '/n/Projects/Plan.md', '/n/a%20b.md?line=3', '/search?q=x', '/trash', '/settings', '/settings/device', '/x/tasks/today']) {
      expect(classify(req(path, { mode: 'navigate', destination: 'document' }), ORIGIN, PRECACHED)).toBe('navigate');
    }
  });

  it('never gives the shell to other navigations (raw files, downloads, health)', () => {
    for (const path of ['/api/files/raw?path=a.pdf', '/api/files/raw?path=a.png&download=true', '/readyz', '/assets/index-abc.js', '/nope', '/settingsx']) {
      expect(classify(req(path, { mode: 'navigate', destination: 'document' }), ORIGIN, PRECACHED)).toBe('network');
    }
  });

  it('answers precached files from the shell cache, but only exact URLs', () => {
    expect(classify(req('/assets/index-abc.js', { destination: 'script' }), ORIGIN, PRECACHED)).toBe('shell');
    expect(classify(req('/theme-boot.js', { destination: 'script' }), ORIGIN, PRECACHED)).toBe('shell');
    expect(classify(req('/theme-boot.js?v=2', { destination: 'script' }), ORIGIN, PRECACHED)).toBe('network');
    expect(classify(req('/assets/other-def.js', { destination: 'script' }), ORIGIN, PRECACHED)).toBe('network');
  });

  it('never answers the API from a cache, except content-addressed note images', () => {
    for (const path of ['/api/tree', '/api/files?path=a.md', '/api/events?clientId=abcdefgh', '/api/settings']) {
      expect(classify(req(path), ORIGIN, PRECACHED)).toBe('network');
    }
    expect(classify(req('/api/files/raw?path=a.png&v=12-34', { destination: 'image' }), ORIGIN, PRECACHED)).toBe('media');
    // Without a content-addressed token the bytes may change: network.
    expect(classify(req('/api/files/raw?path=a.png', { destination: 'image' }), ORIGIN, PRECACHED)).toBe('network');
    // Audio and video use ranges; an iframe'd PDF is not an image request.
    expect(classify(req('/api/files/raw?path=a.mp3&v=1-2', { destination: 'audio', hasRange: true }), ORIGIN, PRECACHED)).toBe('network');
    expect(classify(req('/api/files/raw?path=a.pdf&v=1-2', { destination: 'iframe' }), ORIGIN, PRECACHED)).toBe('network');
  });

  it('leaves writes and other origins alone', () => {
    expect(classify(req('/api/files?path=a.md', { method: 'PUT' }), ORIGIN, PRECACHED)).toBe('network');
    expect(classify(req('/', { method: 'POST', mode: 'navigate' }), ORIGIN, PRECACHED)).toBe('network');
    expect(classify({ ...req('/'), url: 'https://cdn.example.com/x.png', destination: 'image' }, ORIGIN, PRECACHED)).toBe('network');
    expect(classify({ ...req('/'), url: 'not a url' }, ORIGIN, PRECACHED)).toBe('network');
  });

  it('matches the server’s client routes', () => {
    expect(isSpaRoute('/')).toBe(true);
    expect(isSpaRoute('/n/x.md')).toBe(true);
    expect(isSpaRoute('/n')).toBe(false);
    expect(isSpaRoute('/api/tree')).toBe(false);
  });

  it('serves the shell when a navigation gets a gateway or startup error', () => {
    expect(shouldServeShellFor(502)).toBe(true);
    expect(shouldServeShellFor(503)).toBe(true);
    expect(shouldServeShellFor(504)).toBe(true);
    for (const status of [200, 304, 403, 404, 421, 500]) expect(shouldServeShellFor(status)).toBe(false);
  });
});

describe('service worker caches', () => {
  it('precaches every built file except source maps, the worker and robots.txt', () => {
    expect(
      precacheUrls(['index.html', 'assets/index-abc.js', 'assets/index-abc.js.map', 'sw.js', 'robots.txt', 'favicon.svg', 'assets\\win-def.css', '.vite/manifest.json']),
    ).toEqual(['/assets/index-abc.js', '/assets/win-def.css', '/favicon.svg', '/index.html']);
  });

  it("leaves Excalidraw's fonts to the HTTP cache, not the precache", () => {
    expect(precacheUrls(['assets/excalidraw-0.18.1/fonts/Xiaolai/Xiaolai-Regular-1.woff2', 'assets/ExcalidrawView-abc.js', 'index.html'])).toEqual([
      '/assets/ExcalidrawView-abc.js',
      '/index.html',
    ]);
  });

  it("leaves PDF.js's assets to the HTTP cache too", () => {
    expect(precacheUrls(['assets/pdfjs-6.4.299/cmaps/UniJIS-UCS2-H.bcmap', 'assets/pdfjs-6.4.299/wasm/openjpeg.wasm', 'assets/pdfLib-abc.js'])).toEqual([
      '/assets/pdfLib-abc.js',
    ]);
  });

  it('deletes only older shell caches on activation', () => {
    const current = shellCacheName('v2');
    expect(staleShellCaches([shellCacheName('v1'), current, 'notesapp-media', 'other'], current)).toEqual([shellCacheName('v1')]);
  });

  it('trims the oldest media entries', () => {
    expect(overflow([1, 2, 3, 4, 5], 3)).toEqual([1, 2]);
    expect(overflow([1, 2], 3)).toEqual([]);
  });
});

describe('share target', () => {
  it('keeps what another app shares (POST navigation to the share target)', () => {
    expect(classify(req('/capture/share', { method: 'POST', mode: 'navigate', destination: 'document' }), ORIGIN, PRECACHED)).toBe('share');
    expect(classify(req('/capture/share', { method: 'POST', mode: 'cors' }), ORIGIN, PRECACHED)).toBe('network');
    expect(classify(req('/api/capture', { method: 'POST', mode: 'cors' }), ORIGIN, PRECACHED)).toBe('network');
  });

  it('serves the capture page offline like any client route', () => {
    expect(classify(req('/capture?share=abc', { mode: 'navigate', destination: 'document' }), ORIGIN, PRECACHED)).toBe('navigate');
  });
});
