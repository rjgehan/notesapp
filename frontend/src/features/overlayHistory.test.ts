import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeOverlayEntry, navigateOverOverlays, openOverlayEntry, resetOverlayHistory } from './overlayHistory';

/** history.go() and back() land asynchronously, with a popstate event. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const marker = () => (history.state as Record<string, unknown> | null)?.notesappOverlay;

beforeEach(() => {
  resetOverlayHistory(() => true);
  history.replaceState({ key: 'base', idx: 0 }, '', '/n/Base.md');
});

afterEach(() => resetOverlayHistory());

describe('overlay history entries', () => {
  it('adds one entry per overlay that keeps the page URL and router state', () => {
    const length = history.length;
    openOverlayEntry(() => {});
    expect(history.length).toBe(length + 1);
    expect(location.pathname).toBe('/n/Base.md');
    expect(history.state).toMatchObject({ key: 'base', idx: 0 });
    expect(marker()).toEqual(expect.any(String));
  });

  it('closes the topmost overlay on a back gesture and leaves the page alone', async () => {
    const drawer = vi.fn();
    const dialog = vi.fn();
    openOverlayEntry(drawer);
    openOverlayEntry(dialog);
    history.back();
    await settle();
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    history.back();
    await settle();
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/n/Base.md');
    expect(marker()).toBeUndefined();
  });

  it('goes back over the entry when the overlay closes from the UI', async () => {
    const close = vi.fn();
    const token = openOverlayEntry(close);
    closeOverlayEntry(token);
    await settle();
    expect(marker()).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps an overlay (and re-adds its entry) when it refuses to close', async () => {
    let dismissible = false;
    const close = vi.fn(() => (dismissible ? undefined : false));
    openOverlayEntry(close);
    history.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(marker()).toEqual(expect.any(String));
    dismissible = true;
    history.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(2);
    expect(marker()).toBeUndefined();
  });

  it('navigates from the page entry, so history holds pages rather than overlays', async () => {
    const token = openOverlayEntry(() => {});
    const length = history.length;
    navigateOverOverlays(() => history.pushState({ key: 'next', idx: 1 }, '', '/n/Next.md'));
    // The navigation waits until the browser is back on the page's own entry.
    expect(location.pathname).toBe('/n/Base.md');
    closeOverlayEntry(token);
    await settle();
    expect(location.pathname).toBe('/n/Next.md');
    expect(marker()).toBeUndefined();
    // The overlay entry was replaced by the new page.
    expect(history.length).toBe(length);
    history.back();
    await settle();
    expect(location.pathname).toBe('/n/Base.md');
  });

  it('re-adds entries for overlays that stay open across a navigation', async () => {
    const close = vi.fn();
    openOverlayEntry(close);
    navigateOverOverlays(() => history.replaceState({ key: 'moved', idx: 0 }, '', '/n/Moved.md'));
    await settle();
    expect(location.pathname).toBe('/n/Moved.md');
    expect(marker()).toEqual(expect.any(String));
    expect(history.state).toMatchObject({ key: 'moved' });
    history.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/n/Moved.md');
  });

  it('does nothing on devices without touch input', () => {
    resetOverlayHistory(() => false);
    const length = history.length;
    expect(openOverlayEntry(() => {})).toBeNull();
    const run = vi.fn();
    navigateOverOverlays(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(history.length).toBe(length);
  });
});
