import { afterEach, describe, expect, it, vi } from 'vitest';
import { isClipRequest, runClip } from '../src/extension/background';
import type { Browser, Tab } from '../src/extension/browser';
import { clipTab, isClippable } from '../src/extension/clip';
import { deliverClip } from '../src/extension/deliver';
import { downloadImages, imageExtension, imageName, toBase64 } from '../src/extension/images';
import { GECKO_ID, manifest } from '../src/extension/manifest';
import { wantedOrigins } from '../src/extension/options';
import { describe as describeOutcome } from '../src/extension/popup';
import { appPattern, normalizeAppUrl, readSettings } from '../src/extension/settings';
import { CLIP_MESSAGE, type ExtractedClipMessage } from '../src/core/protocol';
import type { Clip } from '../src/core/types';

const CLIP: Clip = {
  title: 'T',
  url: 'https://site.example.com/a',
  author: null,
  siteName: null,
  published: null,
  description: null,
  markdown: '![x](https://cdn.example.com/a.png)',
  images: ['https://cdn.example.com/a.png'],
  selection: false,
};

describe('settings', () => {
  it.each([
    ['notes.tail1234.ts.net', 'https://notes.tail1234.ts.net'],
    ['https://notes.tail1234.ts.net/some/page?x', 'https://notes.tail1234.ts.net'],
    ['http://localhost:5176', 'http://localhost:5176'],
    ['http://127.0.0.1:18320/', 'http://127.0.0.1:18320'],
    ['http://notes.tail1234.ts.net', null],
    ['https://user:pw@notes.example', null],
    ['ftp://notes.example', null],
    ['', null],
  ])('%j is %j', (input, expected) => {
    expect(normalizeAppUrl(input)).toBe(expected);
  });

  it('asks for the app’s host on any port', () => {
    expect(appPattern('http://localhost:5176')).toBe('http://localhost/*');
    expect(appPattern('https://notes.x.ts.net')).toBe('https://notes.x.ts.net/*');
  });

  it('reads stored settings defensively', () => {
    expect(readSettings({})).toEqual({ appUrl: '', folder: 'Clippings', downloadImages: false, autoSave: false });
    expect(readSettings({ appUrl: 'javascript:alert(1)', folder: '../x:y', downloadImages: 'yes', autoSave: true })).toEqual({
      appUrl: '',
      folder: 'xy',
      downloadImages: false,
      autoSave: true,
    });
  });

  it('wants every site only for images', () => {
    expect(wantedOrigins('https://n.ts.net', false)).toEqual(['https://n.ts.net/*']);
    expect(wantedOrigins('https://n.ts.net', true)).toEqual(['https://n.ts.net/*', 'https://*/*', 'http://*/*']);
  });
});

describe('manifest', () => {
  it('runs a service worker in Chrome and an event page in Firefox', () => {
    const chrome = manifest('chrome', '1.2.3');
    const firefox = manifest('firefox', '1.2.3');
    expect(chrome).toMatchObject({ manifest_version: 3, version: '1.2.3', background: { service_worker: 'background.js' } });
    expect(chrome).not.toHaveProperty('browser_specific_settings');
    expect(firefox).toMatchObject({ background: { scripts: ['background.js'] }, browser_specific_settings: { gecko: { id: GECKO_ID } } });
  });

  it('asks for no host access at install', () => {
    for (const m of [manifest('chrome', '1.0.0'), manifest('firefox', '1.0.0')]) {
      expect(m).not.toHaveProperty('host_permissions');
      expect(m).not.toHaveProperty('content_scripts');
      expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage', 'contextMenus']);
      expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    }
  });
});

describe('images', () => {
  it('names images after their URL, with the extension of their type', () => {
    expect(imageName('https://e.com/media/My%20Photo.jpeg?w=100', 'image/jpeg', 0)).toBe('My Photo.jpg');
    expect(imageName('https://e.com/', 'image/png', 2)).toBe('image 3.png');
    expect(imageName('https://e.com/a/b:c*d', 'image/webp', 0)).toBe('b-c-d.webp');
    expect(imageExtension('image/svg+xml; charset=utf-8')).toBe('svg');
    expect(imageExtension('text/html')).toBeNull();
  });

  it('encodes base64', () => {
    expect(toBase64(new TextEncoder().encode('hello'))).toBe(btoa('hello'));
  });

  it('downloads within the limits and leaves the rest as links', async () => {
    const bodies: Record<string, { type: string; bytes: number; ok?: boolean }> = {
      'https://e.com/1.png': { type: 'image/png', bytes: 10 },
      'https://e.com/2.html': { type: 'text/html', bytes: 10 },
      'https://e.com/3.png': { type: 'image/png', bytes: 500 },
      'https://e.com/4.png': { type: 'image/png', bytes: 10, ok: false },
      'https://e.com/5.gif': { type: 'image/gif', bytes: 20 },
      'https://e.com/6.gif': { type: 'image/gif', bytes: 20 },
    };
    const fetchFn = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const b = bodies[String(url)];
      return new Response(new Uint8Array(b.bytes), { status: b.ok === false ? 404 : 200, headers: { 'content-type': b.type } });
    });
    const out = await downloadImages(Object.keys(bodies), { count: 5, maxBytes: 100, totalBytes: 35, timeoutMs: 1000 }, fetchFn as unknown as typeof fetch);
    expect(out.map((i) => i.url)).toEqual(['https://e.com/1.png', 'https://e.com/5.gif']);
    expect(out[0]).toMatchObject({ name: '1.png', type: 'image/png' });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });
});

const message = (autoSave: boolean): ExtractedClipMessage => ({ type: CLIP_MESSAGE, v: 1, kind: 'clip', clip: CLIP, images: [], folder: 'Clippings', autoSave });

describe('deliverClip', () => {
  afterEach(() => {
    delete document.documentElement.dataset.notesappClip;
  });

  it('waits for the page, posts the clip to its own origin and returns', async () => {
    const post = vi.spyOn(window, 'postMessage');
    const done = deliverClip(message(false), 5000);
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'notesapp-clip-ready' }, origin: window.location.origin }));
    await expect(done).resolves.toEqual({ type: 'notesapp-clip-result', status: 'delivered' });
    expect(post).toHaveBeenCalledWith(message(false), window.location.origin);
  });

  it('posts at once to a page that is already ready, and waits for its save', async () => {
    document.documentElement.dataset.notesappClip = 'ready';
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const done = deliverClip(message(true), 5000);
    expect(post).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'notesapp-clip-result', status: 'saved', path: 'Clippings/T.md' }, origin: 'https://evil.example.com' }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'notesapp-clip-result', status: 'saved', path: 'Clippings/T.md' }, origin: window.location.origin }));
    await expect(done).resolves.toMatchObject({ status: 'saved', path: 'Clippings/T.md' });
  });

  it('gives up after its time', async () => {
    vi.useFakeTimers();
    const done = deliverClip(message(false), 1000);
    vi.advanceTimersByTime(1000);
    await expect(done).resolves.toMatchObject({ status: 'timeout' });
    vi.useRealTimers();
  });
});

function fakeBrowser(stored: Record<string, unknown>, granted: string[]) {
  const updated: ((id: number, change: { status?: string }, tab: Tab) => void)[] = [];
  const b = {
    runtime: { openOptionsPage: vi.fn(async () => undefined) },
    storage: { sync: { get: vi.fn(async () => stored) } },
    permissions: { contains: vi.fn(async (p: { origins?: string[] }) => (p.origins ?? []).every((o) => granted.includes(o))) },
    tabs: {
      create: vi.fn(async () => {
        setTimeout(() => updated.forEach((l) => l(99, { status: 'complete' }, { id: 99 })), 0);
        return { id: 99, status: 'loading' } as Tab;
      }),
      get: vi.fn(async () => ({ id: 99, status: 'loading' })),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => ({ id: 99 })),
      onUpdated: { addListener: (l: (typeof updated)[number]) => updated.push(l), removeListener: (l: (typeof updated)[number]) => updated.splice(updated.indexOf(l), 1) },
      onRemoved: { addListener: () => undefined, removeListener: () => undefined },
    },
    scripting: {
      executeScript: vi.fn(async (p: { target: { tabId: number }; files?: string[]; args?: unknown[] }) => {
        if (p.files) return [{}];
        if (p.target.tabId === 1) return [{ result: CLIP }];
        return [{ result: (p.args?.[0] as ExtractedClipMessage).autoSave ? { status: 'saved', path: 'Clippings/T.md' } : { status: 'delivered' } }];
      }),
    },
    action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) },
  };
  return b as unknown as Browser & typeof b;
}

const TAB: Tab = { id: 1, url: 'https://site.example.com/a' };

describe('clipTab', () => {
  it('sends the user to the options until the address is set', async () => {
    const b = fakeBrowser({}, []);
    await expect(clipTab(b, TAB, false)).rejects.toThrow(/address/);
    expect(b.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('needs the permission for the app', async () => {
    const b = fakeBrowser({ appUrl: 'https://notes.x.ts.net' }, []);
    await expect(clipTab(b, TAB, false)).rejects.toThrow(/Allow/);
  });

  it('refuses the browser’s own pages', async () => {
    expect(isClippable('chrome://settings')).toBe(false);
    expect(isClippable('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isClippable('https://example.com')).toBe(true);
    const b = fakeBrowser({ appUrl: 'https://notes.x.ts.net' }, ['https://notes.x.ts.net/*']);
    await expect(clipTab(b, { id: 1, url: 'about:addons' }, false)).rejects.toThrow(/cannot be clipped/);
  });

  it('extracts in the tab, opens /clip and hands the clip over', async () => {
    const b = fakeBrowser({ appUrl: 'https://notes.x.ts.net', folder: 'Web' }, ['https://notes.x.ts.net/*']);
    const outcome = await clipTab(b, TAB, true);
    expect(outcome).toEqual({ status: 'delivered', path: undefined, error: undefined });
    const calls = b.scripting.executeScript.mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({ target: { tabId: 1 }, files: ['content.js'] });
    expect(calls[1]).toMatchObject({ target: { tabId: 1 }, args: [true] });
    expect(b.tabs.create).toHaveBeenCalledWith({ url: 'https://notes.x.ts.net/clip?via=extension', active: true, openerTabId: 1 });
    expect(calls[2].target.tabId).toBe(99);
    expect(calls[2].args?.[0]).toMatchObject({ kind: 'clip', clip: CLIP, images: [], folder: 'Web', autoSave: false });
    expect(b.tabs.remove).not.toHaveBeenCalled();
  });

  it('saves in a background tab and closes it when told to', async () => {
    const b = fakeBrowser({ appUrl: 'https://notes.x.ts.net', autoSave: true, downloadImages: true }, ['https://notes.x.ts.net/*']);
    const outcome = await clipTab(b, TAB, false);
    expect(outcome.status).toBe('saved');
    expect(b.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(b.tabs.remove).toHaveBeenCalledWith(99);
  });
});

describe('background and popup', () => {
  it('recognizes the popup’s request', () => {
    expect(isClipRequest({ type: 'clip', selection: false })).toBe(true);
    expect(isClipRequest({ type: 'clip' })).toBe(false);
    expect(isClipRequest(null)).toBe(false);
  });

  it('turns failures into a badge and an outcome', async () => {
    const b = fakeBrowser({}, []);
    const outcome = await runClip(b, TAB, false);
    expect(outcome.status).toBe('failed');
    expect(b.action.setBadgeText).toHaveBeenCalledWith({ text: '!', tabId: 1 });
  });

  it('describes outcomes', () => {
    expect(describeOutcome({ status: 'saved', path: 'Clippings/T.md' })).toBe('Saved to Clippings/T.md.');
    expect(describeOutcome({ status: 'failed', error: 'Nope' })).toBe('Nope');
  });
});
