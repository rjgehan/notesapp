// The PDF.js loader (ROADMAP item 32, DESIGN §6.8.2). Only the lazy view and embed chunks import this
// module, so PDF.js is downloaded when the first PDF is shown. Everything it fetches is same-origin:
// the worker is a bundled asset and the CMaps, standard fonts and WebAssembly decoders are copied
// under /assets/pdfjs-<version>/ by vite.config.ts.
import type { PDFDocumentLoadingTask, PDFWorker } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type PdfjsModule = typeof import('pdfjs-dist');
export type PdfViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

export interface PdfLib {
  pdfjs: PdfjsModule;
  viewer: PdfViewerModule;
  /** One worker for every open document: a view and its embeds do not start one each. */
  worker: PDFWorker;
}

/** `/assets/pdfjs-<version>/`, where the build serves PDF.js's data files. */
export const PDFJS_ASSETS = import.meta.env.VITE_PDFJS_ASSETS;

let loading: Promise<PdfLib> | null = null;

export function loadPdfLib(): Promise<PdfLib> {
  loading ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    // pdf_viewer.mjs reads the library from globalThis.pdfjsLib, which pdf.mjs sets when it runs.
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    return { pdfjs, viewer, worker: new pdfjs.PDFWorker() };
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/**
 * Opens the document at `url` (a content-addressed raw URL). Ranges only: PDF.js fetches the parts the
 * shown pages need instead of the whole file, which matters for a 300-page scan on the phone.
 */
export function openPdf(lib: PdfLib, url: string): PDFDocumentLoadingTask {
  return lib.pdfjs.getDocument({
    url,
    worker: lib.worker,
    cMapUrl: `${PDFJS_ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
    wasmUrl: `${PDFJS_ASSETS}wasm/`,
    iccUrl: `${PDFJS_ASSETS}iccs/`,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
  });
}

/** Annotation icons (comments, attachments) for the annotation layer. */
export const PDFJS_IMAGES = `${PDFJS_ASSETS}images/`;

/**
 * The viewer's localization, which would otherwise fetch PDF.js's locale files. The app is English;
 * the viewer only labels page landmarks with it, which the controller does itself.
 */
export const pdfL10n = {
  getLanguage: () => 'en-us',
  getDirection: () => 'ltr',
  get: (ids: string | string[]) => Promise.resolve(Array.isArray(ids) ? ids.map(() => '') : ''),
  translate: () => Promise.resolve(),
  translateOnce: () => Promise.resolve(),
  pause: () => {},
  resume: () => {},
  destroy: () => Promise.resolve(),
};
