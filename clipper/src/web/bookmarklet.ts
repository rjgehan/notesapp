// The bookmarklet (DESIGN §6.27.1). It runs in the clipped page's origin, so it never calls the
// API (the Origin check would refuse it, and the page's CSP may block the request anyway). It
// opens the app's /clip page and, once that page says it is ready, posts it the page's HTML and
// selection; /clip extracts the article and saves it after the user's Save. The page's address
// and title also travel in the fragment (never sent to the server), for the paste fallback when
// the page cuts its pop-ups off (Cross-Origin-Opener-Policy).
import { CLIP_MESSAGE, PROTOCOL_VERSION, READY_MESSAGE, type HtmlClipMessage } from '../core/protocol';
import { selectionHtml } from '../core/selection';

/** Replaced by the app's origin when Settings › Web clipper shows the bookmarklet. */
export const ORIGIN_PLACEHOLDER = '__NOTESAPP_ORIGIN__';

export function runBookmarklet(win: Window, origin: string): void {
  const doc = win.document;
  const url = win.location.href;
  const title = doc.title;
  const target = `${origin}/clip?via=bookmarklet#${encodeURIComponent(JSON.stringify({ url, title }))}`;
  const popup = win.open(target, '_blank');
  if (!popup) {
    win.alert('NotesApp could not open its clip window. Allow pop-ups for this site, then click the bookmarklet again.');
    return;
  }
  const message: HtmlClipMessage = {
    type: CLIP_MESSAGE,
    v: PROTOCOL_VERSION,
    kind: 'html',
    url,
    title,
    html: doc.documentElement.outerHTML,
    selectionHtml: selectionHtml(win),
  };
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: unknown } | null;
    if (e.origin !== origin || e.source !== popup || !data || data.type !== READY_MESSAGE) return;
    win.removeEventListener('message', onMessage);
    popup.postMessage(message, origin);
  };
  win.addEventListener('message', onMessage);
}
