import { describe, expect, it, vi } from 'vitest';
import { el } from '../../test/drawings';
import type { EmbeddedRef, StoredFile } from './format';
import { imageBoxes, imageFor, type ImageEnv, type ImageRefs } from './images';

function decode(url: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)));
}

function env(overrides: Partial<ImageEnv> = {}): ImageEnv {
  const files = new Set(['Attachments/one.png', 'Notes/Plan.md', 'Docs/manual.pdf', 'Other.excalidraw']);
  return {
    loadAttachment: vi.fn(async (path: string) => (files.has(path) ? { dataURL: `data:image/png;base64,${btoa(path)}`, mimeType: 'image/png', path } : null)),
    resolveLink: vi.fn((target: string) => [...files].find((f) => f === target || f.endsWith('/' + target) || f.replace(/\.md$/, '').endsWith(target)) ?? null),
    embeddedFile: vi.fn(async (path: string, subpath: string | null) => ({ dataURL: `data:image/svg+xml;base64,${btoa(path + '#' + subpath)}`, mimeType: 'image/svg+xml' })),
    ...overrides,
  };
}

function refs(stored: Record<string, StoredFile> = {}, section: Record<string, EmbeddedRef> = {}): ImageRefs {
  return { stored: new Map(Object.entries(stored)), section: new Map(Object.entries(section)) };
}

describe('imageFor', () => {
  it('uses embedded data URLs as they are and fetches attachments by path', async () => {
    const r = refs({
      a: { id: 'a', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 3 },
      b: { id: 'b', mimeType: 'image/png', path: 'Attachments/one.png' },
    });
    const e = env();
    expect(await imageFor('a', r, e, 'Plan.excalidraw')).toEqual({ id: 'a', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 3 });
    expect(await imageFor('b', r, e, 'Plan.excalidraw')).toMatchObject({ id: 'b', path: 'Attachments/one.png', dataURL: expect.stringMatching(/^data:image\/png/) });
    expect(e.loadAttachment).toHaveBeenCalledWith('Attachments/one.png', 'Plan.excalidraw');
    expect(await imageFor('nothing', r, e, 'Plan.excalidraw')).toBeNull();
  });

  it('never fetches a URL stored in place of embedded data', async () => {
    const r = refs({ web: { id: 'web', mimeType: 'image/png', dataURL: 'https://tracker.example/pixel.png' } });
    const e = env();
    const web = await imageFor('web', r, e, 'Plan.excalidraw');
    expect(web!.dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(decode(web!.dataURL!)).toContain('tracker.example');
    expect(e.loadAttachment).not.toHaveBeenCalled();
  });

  it('shows a missing or failing attachment as a placeholder', async () => {
    const r = refs({ gone: { id: 'gone', mimeType: 'image/png', path: 'Attachments/gone.png' } });
    expect(decode((await imageFor('gone', r, env(), 'P.excalidraw'))!.dataURL!)).toContain('Missing image');
    const failing = env({ loadAttachment: vi.fn(async () => Promise.reject(new Error('503'))) });
    expect(decode((await imageFor('gone', r, failing, 'P.excalidraw'))!.dataURL!)).toContain('Attachments/gone.png');
  });

  it('resolves the Embedded Files entries of an Obsidian drawing', async () => {
    const r = refs(
      {},
      {
        img: { kind: 'link', target: 'one.png' },
        note: { kind: 'link', target: 'Plan', subpath: 'Goals' },
        pdf: { kind: 'link', target: 'manual.pdf' },
        lost: { kind: 'link', target: 'Nowhere' },
        tex: { kind: 'latex', latex: 'e=mc^2' },
        web: { kind: 'url', url: 'https://example.com/a.png' },
        odd: { kind: 'other' },
      },
    );
    const e = env({
      embeddedFile: vi.fn(async (path: string, subpath: string | null) => (path.endsWith('.md') ? { dataURL: `data:image/svg+xml;base64,${btoa(path + '#' + subpath)}`, mimeType: 'image/svg+xml' } : null)),
    });
    const box = { width: 320, height: 200 };
    expect(await imageFor('img', r, e, 'Map.excalidraw.md')).toMatchObject({ path: 'Attachments/one.png' });
    // A note (or a section of one) is the env's static image, sized like its element.
    expect(decode((await imageFor('note', r, e, 'Map.excalidraw.md', box))!.dataURL!)).toBe('Notes/Plan.md#Goals');
    expect(e.embeddedFile).toHaveBeenCalledWith('Notes/Plan.md', 'Goals', 'Map.excalidraw.md', box);
    expect(decode((await imageFor('pdf', r, e, 'Map.excalidraw.md'))!.dataURL!)).toContain('PDF page (shown in Obsidian)');
    expect(decode((await imageFor('lost', r, e, 'Map.excalidraw.md'))!.dataURL!)).toContain('Missing image');
    const formula = decode((await imageFor('tex', r, e, 'Map.excalidraw.md', box))!.dataURL!);
    expect(formula).toContain('e=mc^2');
    expect(formula).toMatch(/width="320" height="200"/);
    expect(decode((await imageFor('web', r, e, 'Map.excalidraw.md'))!.dataURL!)).toContain('Web image (not loaded here)');
    expect(decode((await imageFor('odd', r, e, 'Map.excalidraw.md'))!.dataURL!)).toContain('Embedded file (shown in Obsidian)');
    expect(e.loadAttachment).not.toHaveBeenCalledWith('Docs/manual.pdf', expect.anything());
  });

  it('falls back to a placeholder when an embedded file cannot be shown', async () => {
    const r = refs({}, { draw: { kind: 'link', target: 'Other.excalidraw' } });
    const throwing = env({ embeddedFile: vi.fn(async () => Promise.reject(new Error('boom'))) });
    expect(decode((await imageFor('draw', r, throwing, 'Map.excalidraw.md'))!.dataURL!)).toContain('Other.excalidraw');
    const without = env({ embeddedFile: undefined });
    expect(decode((await imageFor('draw', r, without, 'Map.excalidraw.md'))!.dataURL!)).toContain('Embedded file (shown in Obsidian)');
  });

  it('measures the first live element showing each file', () => {
    const boxes = imageBoxes([
      el('a', { type: 'image', fileId: 'f1', width: 300, height: -120 }),
      el('b', { type: 'image', fileId: 'f1', width: 10, height: 10 }),
      el('c', { type: 'image', fileId: 'f2', width: 50, height: 40, isDeleted: true }),
      el('d', { type: 'rectangle', fileId: 'f3' }),
    ]);
    expect([...boxes]).toEqual([['f1', { width: 300, height: 120 }]]);
  });
});
