import { describe, expect, it, vi } from 'vitest';
import type { AttachmentResult, FileEntry, WriteResult } from '../api/types';
import {
  announceReady,
  base64Blob,
  bookmarkletFor,
  CLIP_MESSAGE,
  fragmentInfo,
  parseClipMessage,
  READY_MESSAGE,
  saveClip,
  toClip,
} from './clip';
import { CLIP, fakeClipper } from '../test/fakeClipper';

const htmlMessage = { type: CLIP_MESSAGE, v: 1, kind: 'html', url: 'https://site.example.com/a', title: 'T', html: '<p>x</p>', selectionHtml: '' };

describe('parseClipMessage', () => {
  it('takes the bookmarklet’s page from another origin, for a preview', () => {
    expect(parseClipMessage(htmlMessage, false)).toEqual({ source: 'bookmarklet', kind: 'html', url: 'https://site.example.com/a', title: 'T', html: '<p>x</p>', selectionHtml: '' });
  });

  it('refuses anything malformed', () => {
    expect(parseClipMessage(null, false)).toBeNull();
    expect(parseClipMessage({ ...htmlMessage, v: 2 }, false)).toBeNull();
    expect(parseClipMessage({ ...htmlMessage, type: 'other' }, false)).toBeNull();
    expect(parseClipMessage({ ...htmlMessage, url: 'javascript:alert(1)' }, false)).toBeNull();
    expect(parseClipMessage({ ...htmlMessage, html: 42 }, false)).toBeNull();
  });

  it('takes an extracted clip only from the app’s own origin (the extension)', () => {
    const msg = { type: CLIP_MESSAGE, v: 1, kind: 'clip', clip: CLIP, images: [], folder: 'Web', autoSave: true };
    expect(parseClipMessage(msg, false)).toBeNull();
    expect(parseClipMessage(msg, true)).toEqual({ source: 'extension', kind: 'clip', clip: CLIP, images: [], folder: 'Web', autoSave: true });
    expect(parseClipMessage({ ...msg, clip: { ...CLIP, images: ['file:///etc/passwd'] } }, true)).toBeNull();
    expect(parseClipMessage({ ...msg, images: [{ url: 'https://e.com/x.png', name: 'x.png', type: 'text/html', data: '' }] }, true)).toBeNull();
    expect(parseClipMessage({ ...msg, images: [{ url: 'https://e.com/x.png', name: 'x.png', type: 'image/png', data: 'AAAA' }] }, true)).toMatchObject({ images: [{ name: 'x.png' }] });
  });
});

describe('fragmentInfo', () => {
  it('reads the address and title the bookmarklet put in the fragment', () => {
    expect(fragmentInfo('#' + encodeURIComponent(JSON.stringify({ url: 'https://e.com/a', title: 'A' })))).toEqual({ url: 'https://e.com/a', title: 'A' });
    expect(fragmentInfo('#' + encodeURIComponent(JSON.stringify({ url: 'data:text/html,x' })))).toBeNull();
    expect(fragmentInfo('#garbage%')).toBeNull();
    expect(fragmentInfo('')).toBeNull();
  });
});

describe('bookmarkletFor', () => {
  it('puts this origin in place of the placeholder, encoded', () => {
    const template = 'javascript:' + encodeURIComponent("var o='__NOTESAPP_ORIGIN__';");
    const out = bookmarkletFor(template, 'https://notes.x.ts.net');
    expect(out).toBe('javascript:' + encodeURIComponent("var o='https://notes.x.ts.net';"));
    expect(bookmarkletFor('<!doctype html>', 'https://n')).toBeNull();
  });
});

describe('toClip', () => {
  it('extracts the bookmarklet’s HTML, or the selection', () => {
    expect(toClip({ source: 'bookmarklet', kind: 'html', url: 'https://e.com/', title: 'Fallback', html: '<title>Real</title>', selectionHtml: '' }, fakeClipper)).toMatchObject({ title: 'Real', markdown: 'HTML:19' });
    expect(toClip({ source: 'bookmarklet', kind: 'html', url: 'https://e.com/', title: 'Fallback', html: '', selectionHtml: '<b>x</b>' }, fakeClipper)).toMatchObject({ title: 'Fallback', markdown: 'SEL:<b>x</b>' });
  });
});

describe('announceReady', () => {
  it('flags the page and tells this window and the opener', () => {
    const post = vi.fn();
    const opener = { postMessage: vi.fn() };
    announceReady({ document, location: window.location, opener, postMessage: post } as unknown as Window);
    expect(document.documentElement.dataset.notesappClip).toBe('ready');
    expect(post).toHaveBeenCalledWith({ type: READY_MESSAGE }, window.location.origin);
    expect(opener.postMessage).toHaveBeenCalledWith({ type: READY_MESSAGE }, '*');
    delete document.documentElement.dataset.notesappClip;
  });
});

const entry = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, basename: 'x', extension: 'md', kind: 'note', size: 1, mtime: '2026-10-21T00:00:00.000Z', version: 'v', aliases: [] });

describe('saveClip', () => {
  it('uploads the images for the note-to-be, points the Markdown at them, then creates the note', async () => {
    const calls: string[] = [];
    const api = {
      uploadAttachment: vi.fn(async (name: string, source: string | null, body: Blob, _opts?: { idempotencyKey?: string }): Promise<AttachmentResult> => {
        calls.push(`upload ${name} for ${source} (${body.size} bytes, ${body.type})`);
        return { file: entry(`Clippings/${name}`), created: true, createdFolders: [], linkText: name, markdown: `![[${name}]]` };
      }),
      createFile: vi.fn(async (req: { path: string; content: string }, _opts?: { idempotencyKey?: string }): Promise<WriteResult> => {
        calls.push(`create ${req.path}`);
        return { file: entry('Clippings/Mine 1.md'), created: true, createdFolders: [] };
      }),
    };
    const keys = ['k1', 'k2'];
    const result = await saveClip(CLIP, [{ url: 'https://cdn.example.com/p.png', name: 'p.png', type: 'image/png', data: btoa('abc') }], { folder: 'Clippings', basename: 'Mine', created: '2026-10-21', newKey: () => keys.shift()! }, fakeClipper, api);
    expect(result.file.path).toBe('Clippings/Mine 1.md');
    expect(calls).toEqual(['upload p.png for Clippings/Mine.md (3 bytes, image/png)', 'create Clippings/Mine.md']);
    expect(api.createFile.mock.calls[0][0].content).toContain('Text ![[p.png]] more ![[p.png]]');
    expect(api.uploadAttachment.mock.calls[0][3]).toEqual({ idempotencyKey: 'k1' });
    expect(api.createFile.mock.calls[0][1]).toEqual({ idempotencyKey: 'k2' });
  });

  it('keeps an image that failed to upload as a link', async () => {
    const api = {
      uploadAttachment: vi.fn(async (): Promise<AttachmentResult> => {
        throw new Error('413');
      }),
      createFile: vi.fn(async (_req: { path: string; content: string }): Promise<WriteResult> => ({ file: entry('Clippings/A page.md'), created: true, createdFolders: [] })),
    };
    await saveClip(CLIP, [{ url: 'https://cdn.example.com/p.png', name: 'p.png', type: 'image/png', data: btoa('abc') }], { folder: 'Clippings', basename: 'A page', created: '2026-10-21', newKey: () => 'k' }, fakeClipper, api);
    expect(api.createFile.mock.calls[0][0]).toMatchObject({ path: 'Clippings/A page.md', onConflict: 'rename' });
    expect(api.createFile.mock.calls[0][0].content).toContain('![pic](https://cdn.example.com/p.png)');
  });

  it('decodes base64 into a typed blob', async () => {
    const blob = base64Blob(btoa('hello'), 'image/gif');
    expect(blob.type).toBe('image/gif');
    expect(blob.size).toBe(5);
  });
});
