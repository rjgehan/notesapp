import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCALE, MIN_SCALE, PinchTracker, ScaleAccumulator, wheelZoomFactor } from './pinch';
import { darkPagesEnabled, lastPage, MAX_POSITIONS, rememberPage, setDarkPages } from './prefs';
import { pageSubpath, parsePdfSubpath } from './subpath';
import { ThumbnailRenderer, type ThumbnailPage } from './thumbnails';

describe('PDF subpaths', () => {
  it('read the page and height of links, embeds and route hashes', () => {
    expect(parsePdfSubpath('page=3')).toEqual({ page: 3, height: null });
    expect(parsePdfSubpath('#page=3&height=400')).toEqual({ page: 3, height: 400 });
    expect(parsePdfSubpath('height=250')).toEqual({ page: null, height: 250 });
    // The route hash of /n/file.pdf#page=3 is percent-encoded by noteRoute.
    expect(parsePdfSubpath('#page%3D12')).toEqual({ page: 12, height: null });
    expect(parsePdfSubpath('page=3&selection=1,2,3')).toEqual({ page: 3, height: null });
  });

  it('ignore what is not a positive whole number', () => {
    for (const s of ['page=0', 'page=-2', 'page=1.5', 'page=x', 'page=', 'Heading', '', null, undefined, '%E0%A4%A']) {
      expect(parsePdfSubpath(s).page).toBeNull();
    }
    expect(pageSubpath(7)).toBe('page=7');
  });
});

describe('pinch gestures', () => {
  it('report each move as a factor, the midpoint and how far it moved', () => {
    const t = new PinchTracker();
    expect(t.move({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
    t.start({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(t.active).toBe(true);
    expect(t.move({ x: 0, y: 0 }, { x: 150, y: 0 })).toEqual({ factor: 1.5, origin: [75, 0], pan: [-25, 0] });
    expect(t.move({ x: 0, y: 10 }, { x: 75, y: 10 })).toEqual({ factor: 0.5, origin: [37.5, 10], pan: [37.5, -10] });
    t.end();
    expect(t.active).toBe(false);
  });

  it('survive two fingers on one spot', () => {
    const t = new PinchTracker();
    t.start({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(t.move({ x: 5, y: 5 }, { x: 6, y: 5 })?.factor).toBe(1);
  });

  it('turn Ctrl+wheel deltas into gentle, bounded factors', () => {
    expect(wheelZoomFactor(0, 0)).toBe(1);
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(Math.E);
    expect(wheelZoomFactor(10000, 0)).toBeCloseTo(1 / Math.E);
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(Math.exp(-0.3));
    expect(wheelZoomFactor(1, 2)).toBeCloseTo(1 / Math.E);
  });

  it('accumulate steps under one percent and stop at the limits', () => {
    const acc = new ScaleAccumulator();
    expect(acc.add(1, 1.004)).toBeNull();
    expect(acc.add(1, 1.004)).toBe(1.01);
    expect(acc.add(1.01, 1)).toBeNull();
    expect(acc.add(MAX_SCALE, 2)).toBeNull();
    // Past the limit nothing piles up: the first step back works at once.
    expect(acc.add(MAX_SCALE, 0.9)).toBe(9);
    expect(acc.add(0.3, 0.1)).toBe(MIN_SCALE);
    acc.add(1, 1.004);
    acc.reset();
    expect(acc.add(1, 1.004)).toBeNull();
  });
});

describe('per-device PDF preferences', () => {
  it('remember the last page per file, forgetting the least recently read', () => {
    expect(lastPage('a.pdf')).toBeNull();
    rememberPage('a.pdf', 4);
    rememberPage('b.pdf', 9);
    expect(lastPage('a.pdf')).toBe(4);
    for (let i = 0; i < MAX_POSITIONS - 1; i++) rememberPage(`x${i}.pdf`, 1);
    expect(lastPage('a.pdf')).toBeNull();
    expect(lastPage('b.pdf')).toBe(9);
    rememberPage('b.pdf', 10);
    rememberPage('new.pdf', 2);
    expect(lastPage('b.pdf')).toBe(10);
  });

  it('ignore stored garbage', () => {
    localStorage.setItem('notesapp:pdf-positions', '{"a.pdf":"3","b.pdf":-1,"c.pdf":2}');
    expect(lastPage('a.pdf')).toBeNull();
    expect(lastPage('b.pdf')).toBeNull();
    expect(lastPage('c.pdf')).toBe(2);
    localStorage.setItem('notesapp:pdf-positions', '[1]');
    expect(lastPage('c.pdf')).toBeNull();
    localStorage.setItem('notesapp:pdf-positions', '{');
    expect(lastPage('c.pdf')).toBeNull();
  });

  it('dim pages in the dark theme unless turned off', () => {
    expect(darkPagesEnabled()).toBe(true);
    setDarkPages(false);
    expect(darkPagesEnabled()).toBe(false);
    setDarkPages(true);
    expect(darkPagesEnabled()).toBe(true);
  });
});

describe('ThumbnailRenderer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function source(log: number[], scales: number[] = []) {
    const pages = new Map<number, ThumbnailPage>();
    const pending = new Map<number, () => void>();
    const getPage = vi.fn(async (n: number) => {
      let page = pages.get(n);
      if (!page) {
        page = {
          getViewport: ({ scale }) => {
            scales.push(scale);
            return { width: 600 * scale, height: 800 * scale };
          },
          render: () => ({ promise: new Promise<void>((resolve) => pending.set(n, () => (log.push(n), resolve()))) }),
        };
        pages.set(n, page);
      }
      return page;
    });
    return { getPage, pending };
  }

  async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it('renders the newest requests first, two at a time, into object URLs it revokes on destroy', async () => {
    let n = 0;
    const created: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      created.push(`blob:${++n}`);
      return `blob:${n}`;
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
      cb(new Blob([`${this.width}x${this.height}`]));
    });
    const log: number[] = [];
    const scales: number[] = [];
    const src = source(log, scales);
    const rendered: number[] = [];
    const r = new ThumbnailRenderer(src, { width: 100, pixelRatio: 3, onRendered: (page) => rendered.push(page) });
    const urls = [1, 2, 3, 4].map((p) => r.request(p));
    expect(r.request(1)).toBe(urls[0]);
    await settle();
    // Two at a time; a waiting request goes newest first (the user scrolled there last).
    expect([...src.pending.keys()]).toEqual([1, 2]);
    src.pending.get(1)!();
    await settle();
    expect([...src.pending.keys()]).toEqual([1, 2, 4]);
    r.cancel(3);
    await expect(urls[2]).resolves.toBeNull();
    src.pending.get(2)!();
    src.pending.get(4)!();
    await expect(urls[0]).resolves.toMatch(/^blob:/);
    await expect(urls[1]).resolves.toMatch(/^blob:/);
    await expect(urls[3]).resolves.toMatch(/^blob:/);
    expect(log).toEqual([1, 2, 4]);
    expect(rendered).toEqual([1, 2, 4]);
    // A cancelled page can be asked for again.
    expect(r.request(3)).not.toBe(urls[2]);
    // The pixel ratio is capped at 2: a 100 px thumbnail is drawn 200 px wide.
    expect(scales.slice(0, 2)).toEqual([1, 200 / 600]);
    // The four pages asked for (the cancelled one never rendered), then page 3 asked again.
    expect(src.getPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 4, 3]);
    r.destroy();
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(created);
  });

  it('resolves null for pages that fail or come after destroy', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(null));
    const failing = { getPage: () => Promise.reject(new Error('gone')) };
    const r = new ThumbnailRenderer(failing);
    await expect(r.request(1)).resolves.toBeNull();
    const log: number[] = [];
    const src = source(log);
    const r2 = new ThumbnailRenderer(src);
    const p = r2.request(1);
    const queued = [r2.request(2), r2.request(3)];
    r2.destroy();
    await expect(queued[1]).resolves.toBeNull();
    await settle();
    src.pending.get(1)?.();
    await expect(p).resolves.toBeNull();
  });
});
