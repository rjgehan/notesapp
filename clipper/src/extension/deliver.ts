// Injected into the app's /clip tab (scripting.executeScript `func`, so it must not use anything
// from outside its own body): waits until the page is ready, posts it the clip, and, when the clip
// saves itself, resolves with the page's result. Content scripts share the page's window, so the
// message arrives from the app's own origin, which is how /clip knows it came from the extension.
import type { ClipResultMessage, ExtractedClipMessage } from '../core/protocol';

export function deliverClip(message: ExtractedClipMessage, waitMs: number): Promise<ClipResultMessage | { type: 'notesapp-clip-result'; status: 'delivered' | 'timeout' }> {
  return new Promise((resolve) => {
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      window.postMessage(message, window.location.origin);
      if (!message.autoSave) finish({ type: 'notesapp-clip-result', status: 'delivered' });
    };
    const timer = setTimeout(() => finish({ type: 'notesapp-clip-result', status: 'timeout' }), waitMs);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: unknown; status?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'notesapp-clip-ready') send();
      else if (data.type === 'notesapp-clip-result' && sent && (data.status === 'saved' || data.status === 'failed')) finish(data as ClipResultMessage);
    };
    function finish(result: ClipResultMessage | { type: 'notesapp-clip-result'; status: 'delivered' | 'timeout' }) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(result);
    }
    window.addEventListener('message', onMessage);
    if (document.documentElement.dataset.notesappClip === 'ready') send();
  });
}
