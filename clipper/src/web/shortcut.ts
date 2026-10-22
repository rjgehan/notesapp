// The iOS Shortcut's "Run JavaScript on Web Page" step (DESIGN §6.27.1). Safari's share sheet
// hands the Shortcut the page, this script extracts the article (or the selection) on the phone
// and returns the body of POST /api/files (API.md §8.2), which the Shortcut's next step sends with
// its X-Client-Id. The server never fetches the page (ROADMAP item 19).
import { extractDocument } from '../core/extract';
import { composeNote, DEFAULT_FOLDER } from '../core/note';
import { selectionHtml } from '../core/selection';

declare const completion: (result: string) => void;

export function shortcutResult(win: Window, folder = DEFAULT_FOLDER): string {
  try {
    const clip = extractDocument(win.document, { url: win.location.href, selectionHtml: selectionHtml(win) });
    return JSON.stringify(composeNote(clip, { folder }));
  } catch (e) {
    return JSON.stringify({ error: `The clipper could not read this page: ${String(e)}` });
  }
}

if (typeof completion === 'function') completion(shortcutResult(window));
