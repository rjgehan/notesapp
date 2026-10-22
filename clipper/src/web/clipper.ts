// /clipper/clipper.js: what the app's /clip page loads (DESIGN §6.27.1) to extract the HTML a
// bookmarklet sent and to compose any clip into a note. Same origin, so the app's CSP allows it.
import { extractHtml } from '../core/extract';
import { composeNote, DEFAULT_FOLDER, localDate, noteBasename, notePath, replaceImage } from '../core/note';

export const api = {
  version: 1,
  defaultFolder: DEFAULT_FOLDER,
  extractHtml,
  composeNote,
  noteBasename,
  notePath,
  replaceImage,
  localDate,
};

(globalThis as unknown as { NotesClipper: typeof api }).NotesClipper = api;
