import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { el, markdownDrawing, scene, text } from '../../test/drawings';
import { excalidrawFontFaces, recordFontFace } from './fonts';
import type { ImageEnv } from './images';
import { fontFaceCss, moveThemeFilters, renderDrawingSvg, unicodeRanges, usedFaces } from './svg';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Builds an SVG like Excalidraw's export: a <text> per text element, a <use> per image, filters in dark mode. */
const exported = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('@excalidraw/excalidraw', () => ({
  exportToSvg: vi.fn(async (opts: { elements: Array<Record<string, unknown>>; appState: { exportWithDarkMode?: boolean }; files: Record<string, unknown> }) => {
    exported.calls.push(opts as unknown as Record<string, unknown>);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '420');
    svg.setAttribute('height', '210');
    if (opts.appState.exportWithDarkMode) svg.setAttribute('filter', 'invert(93%) hue-rotate(180deg)');
    const defs = document.createElementNS(SVG_NS, 'defs');
    const style = document.createElementNS(SVG_NS, 'style');
    style.setAttribute('class', 'style-fonts');
    defs.appendChild(style);
    svg.appendChild(defs);
    for (const e of opts.elements) {
      if (e.type === 'text') {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('font-family', 'Excalifont, Xiaolai, Segoe UI Emoji');
        t.textContent = String(e.text);
        svg.appendChild(t);
      } else if (e.type === 'image') {
        const use = document.createElementNS(SVG_NS, 'use');
        if (opts.appState.exportWithDarkMode) use.setAttribute('filter', 'invert(100%) hue-rotate(180deg) saturate(1.25)');
        svg.appendChild(use);
      }
    }
    return svg;
  }),
}));

const ORIGIN = window.location.origin;
const FONTS = `${ORIGIN}/assets/excalidraw-0.18.1/fonts`;

function imageEnv(): ImageEnv {
  return {
    loadAttachment: vi.fn(async (path: string) => ({ dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png', path })),
    resolveLink: () => null,
  };
}

beforeEach(() => {
  exported.calls = [];
  // Excalidraw registers its faces through the FontFace wrapper (fonts.ts).
  recordFontFace('Excalifont', `url(${FONTS}/Excalifont/latin.woff2) format('woff2'), url(https://esm.sh/x.woff2)`, 'U+0000-00FF, U+0131', ORIGIN);
  recordFontFace('Excalifont', `url(${FONTS}/Excalifont/cyrillic.woff2)`, 'U+0400-045F', ORIGIN);
  recordFontFace('"Xiaolai"', `url(${FONTS}/Xiaolai/cjk-1.woff2)`, 'U+4E00-4FFF, U+60??', ORIGIN);
  recordFontFace('Nunito', `url(${FONTS}/Nunito/latin.woff2)`, 'U+0000-00FF', ORIGIN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url.includes('missing') ? new Response('', { status: 404 }) : new Response(new Uint8Array(70_000).fill(7)))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderDrawingSvg', () => {
  it('exports the live elements with their images, without Excalidraw’s font inlining', async () => {
    const files = { f1: { id: 'f1', mimeType: 'image/png', path: 'Attachments/one.png' } };
    const content = JSON.stringify(scene([text('t', 'Hello 你好'), el('gone', { isDeleted: true }), el('i', { type: 'image', fileId: 'f1', width: 100, height: 50 })], { files }));
    const env = imageEnv();
    const out = await renderDrawingSvg('Plan.excalidraw', content, { dark: false, env });
    expect(out).toMatchObject({ kind: 'svg', width: 420, height: 210 });
    const call = exported.calls[0] as { elements: Array<{ id: string }>; files: Record<string, unknown>; skipInliningFonts: boolean; appState: Record<string, unknown> };
    expect(call.elements.map((e) => e.id)).toEqual(['t', 'i']);
    expect(call.skipInliningFonts).toBe(true);
    expect(call.appState).toMatchObject({ exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false });
    expect(call.files.f1).toMatchObject({ id: 'f1', dataURL: 'data:image/png;base64,AAAA' });
    expect(env.loadAttachment).toHaveBeenCalledWith('Attachments/one.png', 'Plan.excalidraw');
    // The faces the texts use, inlined: Latin and CJK, not Cyrillic or another family.
    const svg = (out as { svg: string }).svg;
    expect(svg.match(/@font-face/g)).toHaveLength(2);
    expect(svg).toContain('font-family: "Excalifont"');
    expect(svg).toContain('font-family: "Xiaolai"');
    expect(svg).toContain('unicode-range: U+0000-00FF, U+0131');
    expect(svg).not.toContain('Nunito');
  });

  it('reads Obsidian drawings, and reports empty and unreadable ones', async () => {
    const md = markdownDrawing({ texts: [['Ab12Cd34', 'Hi']], scene: scene([text('Ab12Cd34', 'Hi')]) });
    expect(await renderDrawingSvg('Map.excalidraw.md', md, { dark: false, env: imageEnv() })).toMatchObject({ kind: 'svg' });
    expect(await renderDrawingSvg('Empty.excalidraw', '', { dark: false, env: imageEnv() })).toEqual({ kind: 'empty' });
    expect(await renderDrawingSvg('Gone.excalidraw', JSON.stringify(scene([el('a', { isDeleted: true })])), { dark: false, env: imageEnv() })).toEqual({ kind: 'empty' });
    expect(await renderDrawingSvg('Bad.excalidraw', '{"elements": [', { dark: false, env: imageEnv() })).toMatchObject({ kind: 'unreadable' });
    expect(await renderDrawingSvg('Note.excalidraw.md', '# Just a note', { dark: false, env: imageEnv() })).toMatchObject({ kind: 'unreadable' });
  });

  it('moves the dark theme’s filters out of CSS functions on SVG elements', async () => {
    const content = JSON.stringify(scene([el('i', { type: 'image', fileId: 'f1' })], { files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' } } }));
    const out = (await renderDrawingSvg('Plan.excalidraw', content, { dark: true, env: imageEnv() })) as { svg: string };
    const doc = new DOMParser().parseFromString(out.svg, 'image/svg+xml');
    expect(doc.documentElement.hasAttribute('filter')).toBe(false);
    expect(doc.querySelector('use')!.getAttribute('filter')).toBe('url(#notesapp-image-invert)');
    const filter = doc.querySelector('filter#notesapp-image-invert')!;
    expect(filter.getAttribute('color-interpolation-filters')).toBe('sRGB');
    expect([...filter.children].map((c) => c.localName)).toEqual(['feComponentTransfer', 'feColorMatrix', 'feColorMatrix']);
  });
});

describe('font inlining', () => {
  it('records the self-hosted file of each face Excalidraw registers', () => {
    const faces = excalidrawFontFaces();
    expect(faces.find((f) => f.url.endsWith('Excalifont/latin.woff2'))).toEqual({ family: 'Excalifont', url: `${FONTS}/Excalifont/latin.woff2`, unicodeRange: 'U+0000-00FF, U+0131' });
    expect(faces.find((f) => f.url.endsWith('cjk-1.woff2'))?.family).toBe('Xiaolai');
    expect(faces.some((f) => f.url.includes('esm.sh'))).toBe(false);
    recordFontFace('Remote', 'url(https://esm.sh/only.woff2)', undefined, ORIGIN);
    expect(excalidrawFontFaces().some((f) => f.family === 'Remote')).toBe(false);
  });

  it('parses unicode ranges, wildcards included', () => {
    expect(unicodeRanges('U+0000-00FF, U+0131,U+60??, bogus')).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x6000, 0x60ff],
    ]);
  });

  it('picks the faces whose family and range a text uses', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('font-family', '"Nunito", sans-serif');
    const t = document.createElementNS(SVG_NS, 'text');
    t.textContent = 'Plain';
    g.appendChild(t);
    svg.appendChild(g);
    expect(usedFaces(svg, excalidrawFontFaces()).map((f) => f.url.slice(FONTS.length))).toEqual(['/Nunito/latin.woff2']);
  });

  it('inlines whole font files of any size, and leaves out one that fails to load', async () => {
    const css = await fontFaceCss([
      { family: 'Big', url: `${FONTS}/big.woff2`, unicodeRange: 'U+0-FF' },
      { family: 'Gone', url: `${FONTS}/missing.woff2`, unicodeRange: 'U+0-FF' },
    ]);
    expect(css.match(/@font-face/g)).toHaveLength(1);
    const data = /url\(data:font\/woff2;base64,([^)]+)\)/.exec(css)![1];
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(70_000);
    expect(bytes.every((b) => b === 7)).toBe(true);
  });
});

describe('moveThemeFilters', () => {
  it('leaves a light export alone', () => {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.appendChild(document.createElementNS(SVG_NS, 'use'));
    moveThemeFilters(svg);
    expect(svg.querySelector('filter')).toBeNull();
  });
});
