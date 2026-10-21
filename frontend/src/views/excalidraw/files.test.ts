import { describe, expect, it } from 'vitest';
import { el } from '../../test/drawings';
import { blobToDataUrl, croppedFileIds, dataUrlToBlob, filesToStore, isPastedName, referencedFileIds, scaleCrop, type FileSources } from './files';
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

describe('crops of scaled-down images', () => {
  const natural = { width: 2880, height: 2160 };
  const display = { width: 1440, height: 1080 };

  it('converts a crop between the pixels of the copy shown and the original', () => {
    const shown = el('i', { type: 'image', fileId: 'f', crop: { x: 10, y: 20, width: 100, height: 50, naturalWidth: 1440, naturalHeight: 1080 } });
    const stored = scaleCrop(shown, display, natural);
    expect(stored.crop).toEqual({ x: 20, y: 40, width: 200, height: 100, naturalWidth: 2880, naturalHeight: 2160 });
    expect(scaleCrop(stored, natural, display).crop).toEqual(shown.crop);
  });

  it('leaves crops in other pixels, uncropped images and other elements alone', () => {
    const other = el('i', { type: 'image', fileId: 'f', crop: { x: 1, y: 1, width: 5, height: 5, naturalWidth: 800, naturalHeight: 600 } });
    expect(scaleCrop(other, display, natural)).toBe(other);
    const plain = el('j', { type: 'image', fileId: 'g', crop: null });
    expect(scaleCrop(plain, display, natural)).toBe(plain);
    expect(croppedFileIds([other, plain, el('k', { type: 'image', fileId: 'h', crop: other.crop, isDeleted: true })])).toEqual(new Set(['f']));
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
