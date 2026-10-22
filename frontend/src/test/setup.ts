import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { api } from '../api/endpoints';
// In the app a session loads its CodeMirror parts with its file (a lazy chunk); in tests they are
// here from the start, so a session's load takes no extra turn.
import '../sync/sessionKit';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// Components that show bookmark stars load the bookmarks; without a server they are empty (tests that
// need some mock the endpoint themselves).
beforeEach(() => {
  if (!vi.isMockFunction(api.getBookmarks)) vi.spyOn(api, 'getBookmarks').mockResolvedValue({ version: 'b0', items: [] });
});

// jsdom lacks layout APIs that CodeMirror and the UI touch; give them inert implementations.
if (!document.createRange().getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
