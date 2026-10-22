// The hand-off to the app's /clip page (DESIGN §6.27.1). Neither the bookmarklet nor the extension
// ever calls the API: the bookmarklet runs inside someone else's origin, and an extension's origin
// (chrome-extension://…, moz-extension://<random per install>) would fail the API's Origin and
// Sec-Fetch-Site checks (API.md §2). Both pass the clip to /clip with postMessage, and the page,
// which is the app's own origin, saves it through the ordinary same-origin API.
import type { Clip } from './types';

export const PROTOCOL_VERSION = 1;

/** /clip → its opener (the bookmarklet) and its own window (the extension): ready to receive. */
export const READY_MESSAGE = 'notesapp-clip-ready';

/** Bookmarklet or extension → /clip: the clip. */
export const CLIP_MESSAGE = 'notesapp-clip';

/** /clip → its own window (the extension): what became of the clip. */
export const RESULT_MESSAGE = 'notesapp-clip-result';

/** The bookmarklet's message: the page's HTML, which /clip extracts. */
export interface HtmlClipMessage {
  type: typeof CLIP_MESSAGE;
  v: typeof PROTOCOL_VERSION;
  kind: 'html';
  url: string;
  title: string;
  html: string;
  /** The selection's HTML, `''` when nothing was selected. */
  selectionHtml: string;
}

/** An image the extension downloaded, to store as an attachment. */
export interface ClipImage {
  /** The URL the Markdown shows it by. */
  url: string;
  /** A file name for POST /api/attachments (the server sanitizes it, API.md §9.3). */
  name: string;
  /** Its MIME type. */
  type: string;
  /** Base64 of the bytes (extension messages are JSON in Chrome). */
  data: string;
}

/** The extension's message: a clip it already extracted, with any downloaded images. */
export interface ExtractedClipMessage {
  type: typeof CLIP_MESSAGE;
  v: typeof PROTOCOL_VERSION;
  kind: 'clip';
  clip: Clip;
  images: ClipImage[];
  /** The folder from the extension's options. */
  folder: string;
  /** Save without waiting for the Save button (only honoured from the app's own origin). */
  autoSave: boolean;
}

export type ClipMessage = HtmlClipMessage | ExtractedClipMessage;

export interface ClipResultMessage {
  type: typeof RESULT_MESSAGE;
  status: 'saved' | 'failed';
  /** The note's vault path when saved. */
  path?: string;
  error?: string;
}
