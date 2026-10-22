import { describe, expect, it, vi } from 'vitest';
import { CLIP_MESSAGE, READY_MESSAGE, type HtmlClipMessage } from '../src/core/protocol';
import { ORIGIN_PLACEHOLDER, runBookmarklet } from '../src/web/bookmarklet';
import { shortcutResult } from '../src/web/shortcut';
import { api } from '../src/web/clipper';

const APP = 'https://notes.example.ts.net';

function fakeWindow() {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const popup = { postMessage: vi.fn() };
  const win = {
    document,
    location: { href: 'https://site.example.com/post?id=1' },
    open: vi.fn(() => popup),
    alert: vi.fn(),
    getSelection: () => window.getSelection(),
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.push(l),
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.splice(listeners.indexOf(l), 1),
  };
  const dispatch = (data: unknown, origin: string, source: unknown) => {
    for (const l of [...listeners]) l({ data, origin, source } as MessageEvent);
  };
  return { win: win as unknown as Window, popup, listeners, dispatch };
}

describe('bookmarklet', () => {
  it('opens /clip with the address and title in the fragment', () => {
    document.title = 'A post';
    const { win } = fakeWindow();
    runBookmarklet(win, APP);
    const [url, target] = (win.open as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(target).toBe('_blank');
    expect(url.startsWith(`${APP}/clip?via=bookmarklet#`)).toBe(true);
    expect(JSON.parse(decodeURIComponent(url.split('#')[1]))).toEqual({ url: 'https://site.example.com/post?id=1', title: 'A post' });
  });

  it('posts the page only to the app, once it says it is ready', () => {
    document.body.innerHTML = '<p id="p">Some <i>text</i></p>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p')!);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const { win, popup, listeners, dispatch } = fakeWindow();
    runBookmarklet(win, APP);
    dispatch({ type: READY_MESSAGE }, 'https://evil.example.com', popup);
    dispatch({ type: READY_MESSAGE }, APP, {});
    dispatch({ type: 'other' }, APP, popup);
    expect(popup.postMessage).not.toHaveBeenCalled();
    dispatch({ type: READY_MESSAGE }, APP, popup);
    expect(popup.postMessage).toHaveBeenCalledTimes(1);
    const [message, origin] = popup.postMessage.mock.calls[0] as [HtmlClipMessage, string];
    expect(origin).toBe(APP);
    expect(message).toMatchObject({ type: CLIP_MESSAGE, v: 1, kind: 'html', url: 'https://site.example.com/post?id=1', selectionHtml: 'Some <i>text</i>' });
    expect(message.html).toContain('<p id="p">');
    expect(listeners).toHaveLength(0);
  });

  it('says so when pop-ups are blocked', () => {
    const { win } = fakeWindow();
    (win.open as ReturnType<typeof vi.fn>).mockReturnValue(null);
    runBookmarklet(win, APP);
    expect(win.alert).toHaveBeenCalled();
  });

  it('keeps a placeholder the settings page fills in', () => {
    expect(ORIGIN_PLACEHOLDER).toMatch(/^[A-Z_]+$/);
  });
});

describe('iOS Shortcut script', () => {
  it('returns the POST /api/files body for the page', () => {
    document.title = 'Shortcut page';
    document.body.innerHTML = '<article><h1>Shortcut page</h1><p>Hello from the phone.</p></article>';
    window.getSelection()?.removeAllRanges();
    const win = { document, location: { href: 'https://m.example.com/x#top' }, getSelection: () => window.getSelection() } as unknown as Window;
    const body = JSON.parse(shortcutResult(win)) as { path: string; content: string; onConflict: string };
    expect(body.path).toBe('Clippings/Shortcut page.md');
    expect(body.onConflict).toBe('rename');
    expect(body.content).toContain('source: "https://m.example.com/x"');
    expect(body.content).toContain('Hello from the phone.');
  });

  it('reports a page it cannot read', () => {
    const win = { document: null, location: { href: 'x' }, getSelection: () => null } as unknown as Window;
    expect(JSON.parse(shortcutResult(win))).toHaveProperty('error');
  });
});

describe('clipper.js', () => {
  it('exposes what the /clip page uses', () => {
    expect((globalThis as unknown as { NotesClipper: typeof api }).NotesClipper).toBe(api);
    expect(api.version).toBe(1);
    expect(api.defaultFolder).toBe('Clippings');
    expect(typeof api.extractHtml).toBe('function');
    expect(typeof api.composeNote).toBe('function');
    expect(typeof api.replaceImage).toBe('function');
  });
});
