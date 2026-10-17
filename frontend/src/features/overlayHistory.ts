// History entries for overlays on touch devices (DESIGN §6.4, §6.16): every open drawer, sheet,
// dialog and menu owns one browser history entry above the page's own, so Safari's edge swipe or
// the back button closes the topmost overlay instead of leaving the note.
//
// The entries repeat the page's URL and router state, plus a marker. A small reconciler keeps the
// browser's entries in step with the open overlays:
// - closing an overlay from the UI goes back over its entry;
// - navigating while overlays are open first goes back to the page's entry, then navigates, then
//   adds entries again for the overlays that are still open, so history holds pages, not overlays;
// - nothing is pushed, and no navigation runs, while one of its own traversals is in flight:
//   history.go() is asynchronous, and a push made before it lands would be the entry it removes.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { isCoarsePointer } from './platform';

const MARK = 'notesappOverlay';

interface OpenOverlay {
  token: string;
  /** Closes the overlay after a back gesture; returning false keeps it open (and its entry). */
  close(): boolean | void;
}

let enabled: () => boolean = isCoarsePointer;
/** Open overlays that own an entry, oldest first. */
let open: OpenOverlay[] = [];
/** Tokens of this page's overlay entries currently in the browser history, oldest first. */
let pushed: string[] = [];
let traversing = false;
let navigations: Array<() => void> = [];
let installed = false;
let seq = 0;
// History state survives reloads, so tokens must not repeat across page loads.
const pageId = Math.random().toString(36).slice(2, 8);

function stateToken(state: unknown): string | null {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : undefined;
  return typeof value === 'string' ? value : null;
}

function sync(): void {
  if (traversing) return;
  // A pending navigation must run on the page's own entry, so it keeps no overlay entry.
  let keep = 0;
  if (navigations.length === 0) {
    while (keep < pushed.length && keep < open.length && pushed[keep] === open[keep].token) keep++;
  }
  if (pushed.length > keep) {
    const steps = pushed.length - keep;
    pushed = pushed.slice(0, keep);
    traversing = true;
    window.history.go(-steps);
    return;
  }
  const runs = navigations;
  navigations = [];
  for (const run of runs) run();
  for (const overlay of open.slice(pushed.length)) {
    window.history.pushState({ ...(window.history.state as object | null), [MARK]: overlay.token }, '');
    pushed.push(overlay.token);
  }
}

function onPopState(e: PopStateEvent): void {
  if (traversing) {
    traversing = false;
    sync();
    return;
  }
  // The user moved through history: the overlays above the entry they reached are closed.
  const token = stateToken(e.state);
  const at = token === null ? -1 : pushed.indexOf(token);
  if (token !== null && at < 0) {
    // Forward onto the entry of an overlay that is gone: it becomes an ordinary page entry.
    const rest = { ...(e.state as Record<string, unknown>) };
    delete rest[MARK];
    window.history.replaceState(rest, '');
  }
  const gone = pushed.slice(at + 1).reverse();
  pushed = pushed.slice(0, at + 1);
  for (const t of gone) {
    const overlay = open.find((o) => o.token === t);
    if (overlay && overlay.close() !== false) open = open.filter((o) => o !== overlay);
  }
  sync();
}

/**
 * At startup: the page may have been reloaded while an overlay entry was current. That entry now
 * belongs to no overlay, so it becomes an ordinary page entry.
 */
export function clearStaleOverlayEntry(): void {
  if (stateToken(window.history.state) === null) return;
  const rest = { ...(window.history.state as Record<string, unknown>) };
  delete rest[MARK];
  window.history.replaceState(rest, '');
}

/** Adds a history entry for an overlay that just opened; null when overlays get no entries. */
export function openOverlayEntry(close: () => boolean | void): string | null {
  if (!enabled()) return null;
  if (!installed) {
    installed = true;
    window.addEventListener('popstate', onPopState);
  }
  const token = `${pageId}-${++seq}`;
  open.push({ token, close });
  sync();
  return token;
}

/** The overlay closed from the UI: its entry is removed (the browser goes back over it). */
export function closeOverlayEntry(token: string | null): void {
  if (token === null || !open.some((o) => o.token === token)) return;
  open = open.filter((o) => o.token !== token);
  sync();
}

/**
 * Runs a navigation once the browser is back on the page's own entry. Without overlay entries
 * it runs at once.
 */
export function navigateOverOverlays(run: () => void): void {
  if (pushed.length === 0 && !traversing) {
    run();
    return;
  }
  navigations.push(run);
  sync();
}

/** Gives `active` overlays a history entry; a back gesture calls `close`. */
export function useOverlayHistory(active: boolean, close: () => boolean | void): void {
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!active) return;
    const token = openOverlayEntry(() => closeRef.current());
    return () => closeOverlayEntry(token);
  }, [active]);
}

/** Tests: force entries on or off and start from a clean slate. */
export function resetOverlayHistory(isEnabled: () => boolean = isCoarsePointer): void {
  enabled = isEnabled;
  open = [];
  pushed = [];
  traversing = false;
  navigations = [];
}
