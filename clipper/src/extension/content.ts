// content.js: injected into the clipped tab on a click (activeTab). It only defines the extractor;
// the background then calls it and receives the clip.
import { extractDocument } from '../core/extract';
import { selectionHtml } from '../core/selection';
import type { Clip } from '../core/types';

(globalThis as unknown as { __notesappClip: (selection: boolean) => Clip }).__notesappClip = (selection: boolean) =>
  extractDocument(document, { url: location.href, selectionHtml: selection ? selectionHtml(window) : null });
