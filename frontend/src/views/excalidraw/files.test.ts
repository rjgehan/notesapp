import { describe, expect, it } from 'vitest';
import { el } from '../../test/drawings';
import { blobToDataUrl, dataUrlToBlob, filesToStore, isPastedName, placeholderDataUrl, referencedFileIds, type FileSources } from './files';
import { sameOriginFontSources } from './fonts';

const none: FileSources = { stored: new Map(), section: new Set(), vault: new Map() };

describe('filesToStore', () => {
  const images = [el('a', { type: 'image', fileId: 'f1' }), el('b', { type: 'image', fileId: 'f2' }), el('gone', { type: 'image', fileId: 'f3', isDeleted: true }), el('r')];

  it('lists only files that live images use', () => {
    expect(referencedFileIds(images)).toEqual(['f1', 'f2']);
  });

  it('stores attachments by vault path and keeps embedded data as it was', () => {
    const sources: FileSources = {
      stored: new Map([['f1', { id: 'f1', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,AAA', extra: 'kept' }]]),
      section: new Set(),
      vault: new Map([['f2', { path: 'Attachments/b.png', mimeType: 'image/png', created: 2 }]]),
    };
    // Excalidraw's in-memory copies carry data URLs; none of that is written for an attachment.
    const live = { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:other' }, f2: { id: 'f2', mimeType: 'image/png', dataURL: 'data:image/png;base64,BIG' } };
    const out = filesToStore('excalidraw', images, live, sources);
    expect(out.files).toEqual({
      f1: { id: 'f1', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,AAA', extra: 'kept' },
      f2: { mimeType: 'image/png', id: 'f2', created: 2, path: 'Attachments/b.png' },
    });
    expect(out.attachments).toEqual([]);
  });

  it('keeps a pasted image that carries its vault path (copied from another drawing)', () => {
    const live = { f1: { id: 'f1', mimeType: 'image/jpeg', created: 3, dataURL: 'data:image/jpeg;base64,X', path: 'Attachments/a.jpg' } };
    expect(filesToStore('excalidraw', [images[0]], live, none).files).toEqual({ f1: { mimeType: 'image/jpeg', id: 'f1', created: 3, path: 'Attachments/a.jpg' } });
  });

  it('lists attachments of a Markdown drawing under Embedded Files instead of the JSON', () => {
    const sources: FileSources = { stored: new Map(), section: new Set(['f1']), vault: new Map([['f2', { path: 'Attachments/b.png', mimeType: 'image/png', created: 2 }]]) };
    expect(filesToStore('markdown', images, {}, sources)).toEqual({ files: {}, attachments: [{ id: 'f2', path: 'Attachments/b.png' }] });
  });
});

describe('image helpers', () => {
  it('recognises clipboard images by their generic names', () => {
    expect(isPastedName('image.png')).toBe(true);
    expect(isPastedName('')).toBe(true);
    expect(isPastedName('Holiday.jpg')).toBe(false);
  });

  it('round-trips data URLs', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(8);
    expect(await blobToDataUrl(blob)).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(await dataUrlToBlob('data:text/plain,a%20b').text()).toBe('a b');
  });

  it('draws placeholders as SVG data URLs, with the text escaped', () => {
    const url = placeholderDataUrl('Missing image', '<script>&"x"</script>');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = new TextDecoder().decode(Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)));
    expect(svg).toContain('&lt;script&gt;&amp;&quot;x&quot;&lt;/script&gt;');
    expect(svg).not.toContain('<script>');
  });
});

describe('sameOriginFontSources', () => {
  const origin = 'https://notes.example.ts.net';

  it('drops the CDN fallback Excalidraw lists after the self-hosted font', () => {
    const src = `url(${origin}/assets/excalidraw-0.18.1/fonts/Virgil/Virgil-Regular.woff2) format('woff2'), url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Virgil/Virgil-Regular.woff2) format('woff2')`;
    expect(sameOriginFontSources(src, origin)).toBe(`url(${origin}/assets/excalidraw-0.18.1/fonts/Virgil/Virgil-Regular.woff2) format('woff2')`);
  });

  it('keeps relative, data and local sources, and everything when nothing would remain', () => {
    expect(sameOriginFontSources(`url("/a.woff2"), url(data:font/woff2;base64,AA==), local(Arial)`, origin)).toBe(`url("/a.woff2"), url(data:font/woff2;base64,AA==), local(Arial)`);
    const cdnOnly = 'url(https://esm.sh/x.woff2)';
    expect(sameOriginFontSources(cdnOnly, origin)).toBe(cdnOnly);
  });
});
