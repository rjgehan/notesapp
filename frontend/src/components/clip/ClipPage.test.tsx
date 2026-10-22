import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, httpEndpoints, installEndpoints } from '../../api/endpoints';
import type { AttachmentResult, CreateFileRequest, FileEntry, WriteResult } from '../../api/types';
import { CLIP_MESSAGE, READY_MESSAGE, RESULT_MESSAGE } from '../../features/clip';
import { CLIP, fakeClipper } from '../../test/fakeClipper';
import { bookmarkletFor } from '../../features/clip';
import { ClipPage } from './ClipPage';
import { ClipperSettings } from './ClipperSettings';

const entry = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, basename: 'x', extension: 'md', kind: 'note', size: 1, mtime: '2026-10-21T00:00:00.000Z', version: 'v', aliases: [] });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClipPage />
    </QueryClientProvider>,
  );
}

function deliver(data: unknown, origin = window.location.origin, source: MessageEventSource | null = window) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  });
}

let createFile: ReturnType<typeof vi.fn<(req: CreateFileRequest) => Promise<WriteResult>>>;
let uploadAttachment: ReturnType<typeof vi.fn<(name: string) => Promise<AttachmentResult>>>;

beforeEach(() => {
  (window as unknown as { NotesClipper?: unknown }).NotesClipper = fakeClipper;
  createFile = vi.fn(async (req: CreateFileRequest): Promise<WriteResult> => ({ file: entry(req.path), created: true, createdFolders: [] }));
  uploadAttachment = vi.fn(async (name: string): Promise<AttachmentResult> => ({ file: entry(`Clippings/${name}`), created: true, createdFolders: [], linkText: name, markdown: `![[${name}]]` }));
  installEndpoints({ ...api, getTree: () => new Promise(() => {}), getSettings: () => new Promise(() => {}), createFile, uploadAttachment });
});

afterEach(() => {
  installEndpoints(httpEndpoints);
  delete (window as unknown as { NotesClipper?: unknown }).NotesClipper;
  delete document.documentElement.dataset.notesappClip;
});

describe('/clip', () => {
  it('says it is ready, previews the extension’s clip and saves it on Save', async () => {
    const posted = vi.spyOn(window, 'postMessage');
    renderPage();
    await waitFor(() => expect(document.documentElement.dataset.notesappClip).toBe('ready'));
    expect(posted).toHaveBeenCalledWith({ type: READY_MESSAGE }, window.location.origin);
    deliver({ type: CLIP_MESSAGE, v: 1, kind: 'clip', clip: CLIP, images: [], folder: 'Web', autoSave: false });
    expect(await screen.findByLabelText('Note name')).toHaveValue('A page');
    expect(screen.getByLabelText('Folder')).toHaveValue('Web');
    expect(screen.getByText('Web/A page.md')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note name'), { target: { value: 'Renamed' } });
    expect(createFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved to Web/Renamed.md.'));
    expect(createFile.mock.calls[0][0]).toMatchObject({ path: 'Web/Renamed.md', onConflict: 'rename' });
    expect(posted).toHaveBeenCalledWith({ type: RESULT_MESSAGE, status: 'saved', path: 'Web/Renamed.md' }, window.location.origin);
  });

  it('saves the extension’s clip at once when told to, images first', async () => {
    renderPage();
    await waitFor(() => expect(document.documentElement.dataset.notesappClip).toBe('ready'));
    deliver({ type: CLIP_MESSAGE, v: 1, kind: 'clip', clip: CLIP, images: [{ url: 'https://cdn.example.com/p.png', name: 'p.png', type: 'image/png', data: btoa('x') }], folder: null, autoSave: true });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved to Clippings/A page.md.'));
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(createFile.mock.calls[0][0].content).toContain('![[p.png]]');
  });

  it('never saves a bookmarklet’s page without Save, and ignores other windows', async () => {
    const opener = { postMessage: vi.fn() };
    Object.defineProperty(window, 'opener', { value: opener, configurable: true });
    renderPage();
    await waitFor(() => expect(opener.postMessage).toHaveBeenCalledWith({ type: READY_MESSAGE }, '*'));
    const page = { type: CLIP_MESSAGE, v: 1, kind: 'html', url: 'https://site.example.com/a', title: 'T', html: '<title>From the page</title>', selectionHtml: '' };
    // An extracted clip from another origin, and a page from a window that is not the opener, are ignored.
    deliver({ type: CLIP_MESSAGE, v: 1, kind: 'clip', clip: CLIP, images: [], folder: null, autoSave: true }, 'https://site.example.com', opener as unknown as Window);
    deliver(page, 'https://site.example.com', {} as Window);
    expect(screen.queryByLabelText('Note name')).toBeNull();
    deliver({ ...page, autoSave: true }, 'https://site.example.com', opener as unknown as Window);
    expect(await screen.findByLabelText('Note name')).toHaveValue('From the page');
    expect(createFile).not.toHaveBeenCalled();
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
  });

  it('says so when the server has no clipper build', async () => {
    delete (window as unknown as { NotesClipper?: unknown }).NotesClipper;
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      queueMicrotask(() => (node as HTMLScriptElement).onerror?.(new Event('error')));
      return node;
    });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('no clipper build');
    append.mockRestore();
  });
});

describe('Settings › Web clipper', () => {
  it('offers the bookmarklet for this origin and the Shortcut’s steps', async () => {
    const template = 'javascript:' + encodeURIComponent("open('__NOTESAPP_ORIGIN__/clip')");
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('bookmarklet.js') ? new Response(template, { headers: { 'content-type': 'text/javascript' } }) : new Response('completion("x")', { headers: { 'content-type': 'text/javascript' } }),
    );
    render(<ClipperSettings />);
    const link = await screen.findByTitle('Drag me to the bookmarks bar');
    await waitFor(() => expect(link.getAttribute('href')).toBe(bookmarkletFor(template, window.location.origin)));
    expect(screen.getByText(`${window.location.origin}/api/files`)).toBeInTheDocument();
    expect(screen.getByText('ios-shortcut-clipper')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy the script/ })).toBeEnabled();
  });

  it('says when the server was built without the clipper', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    render(<ClipperSettings />);
    expect((await screen.findAllByText(/built without the clipper/)).length).toBe(2);
    expect(screen.queryByTitle('Drag me to the bookmarks bar')).toBeNull();
  });
});
