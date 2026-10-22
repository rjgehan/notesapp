// "Open in a new tab" gestures (ROADMAP item 11, DESIGN §6.40): a middle click, or a Mod-click or
// Mod-Enter on something that opens a file (explorer, search, backlinks, the reading view, a
// locked note, the quick switcher). In an editable note Mod-click is how a link is followed, so
// there Mod-Shift-click opens it in a new tab. The gesture is recorded in the capture phase and
// read by `navigateTo` during the same event, so every way of opening a file honours it without
// each caller knowing about tabs.
import { isApple, modKey } from '../features/platform';

/** Elements whose middle click opens what they point at. */
export const NAV_TARGETS =
  '[role="treeitem"], [role="option"], .cm-content, a.internal-link, .markdown-rendered a, .backlink-source, .backlink-context, .backlink-block, .search-hit-title, .search-match, .recent-open, .link-button, .status-file-link, .outline-item';

let pending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const synthetic = new WeakSet<Event>();

function record(newTab: boolean): void {
  pending = newTab;
  if (timer !== null) clearTimeout(timer);
  // Only navigations made while this event is dispatched count.
  timer = setTimeout(() => {
    pending = false;
    timer = null;
  }, 0);
}

function inEditableEditor(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.cm-content[contenteditable="true"]');
}

/** Whether a click or key press asks for a new tab. */
export function wantsNewTab(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: EventTarget | null }): boolean {
  if (!modKey(e)) return false;
  return inEditableEditor(e.target) ? e.shiftKey : true;
}

/** True once, when the event being dispatched asked for a new tab. */
export function takeNewTabGesture(): boolean {
  const p = pending;
  pending = false;
  return p;
}

function isExternalLink(target: Element): boolean {
  const a = target.closest('a[href]');
  return !!a && /^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute('href') ?? '') && !a.classList.contains('internal-link');
}

export function installTabGestures(): () => void {
  const onClick = (e: MouseEvent) => {
    if (synthetic.has(e)) return;
    record(e.button === 0 && wantsNewTab(e));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') record(wantsNewTab(e));
  };
  const navTarget = (e: MouseEvent): Element | null => {
    if (e.button !== 1 || !(e.target instanceof Element)) return null;
    const el = e.target.closest(NAV_TARGETS);
    return el && !isExternalLink(e.target) ? el : null;
  };
  // Middle-button autoscroll would start on these; the click opens a tab instead.
  const onMouseDown = (e: MouseEvent) => {
    if (navTarget(e)) e.preventDefault();
  };
  const onAuxClick = (e: MouseEvent) => {
    if (!navTarget(e) || !(e.target instanceof Element)) return;
    e.preventDefault();
    e.stopPropagation();
    // Replayed as a Mod-click (which follows a link even in an editable note), flagged as a new tab.
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrlKey: !isApple,
      metaKey: isApple,
    });
    synthetic.add(click);
    record(true);
    e.target.dispatchEvent(click);
  };
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('auxclick', onAuxClick, true);
  return () => {
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('auxclick', onAuxClick, true);
  };
}
