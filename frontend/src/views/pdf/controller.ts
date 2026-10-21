// The PDF viewer outside React (ROADMAP item 32, DESIGN §6.8.3): PDF.js's PDFViewer over a scroll
// container, with its link service and find controller, plus pinch zoom, a remembered page and the
// state the toolbar shows. The view and the embed each own one; a controller can be mounted again
// after it was unmounted (React's StrictMode does that), and it opens its document on every mount.
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { openPdf, pdfL10n, PDFJS_IMAGES, type PdfLib } from './pdfLib';
import { attachPinch, ScaleAccumulator, type ZoomStep } from './pinch';

export type FindResult = 'idle' | 'pending' | 'found' | 'not-found' | 'wrapped';

export interface FindStatus {
  query: string;
  /** 1-based index of the selected match, 0 for none. */
  current: number;
  total: number;
  result: FindResult;
}

export interface PdfViewState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  pages: number;
  /** 1-based current page. */
  page: number;
  /** 1 = 100 %. */
  scale: number;
  /** A preset (`auto`, `page-width`, `page-fit`) while one applies, otherwise the scale as a string. */
  scaleValue: string;
  find: FindStatus;
}

export interface PdfControllerOptions {
  /** The page to show first, from a link's `#page=N` or the remembered page. */
  initialPage?: number | null;
  /** The initial zoom; `auto` (the page width, up to 125 %) by default. */
  scaleValue?: string;
  /** Two-finger and Ctrl+wheel zoom; embeds leave those to the page. */
  pinch?: boolean;
  onPageChange?(page: number): void;
  /** Asks for the document's password; null cancels. `retry` is true after a wrong one. */
  askPassword?(retry: boolean): Promise<string | null>;
}

export const PRESET_SCALES = ['auto', 'page-width', 'page-fit'] as const;

/** Zoom gestures render at the new scale once the fingers rest this long; until then the pages are stretched. */
const PINCH_DRAWING_DELAY_MS = 400;

const NO_FIND: FindStatus = { query: '', current: 0, total: 0, result: 'idle' };

const INITIAL: PdfViewState = { status: 'loading', error: null, pages: 0, page: 1, scale: 1, scaleValue: 'auto', find: NO_FIND };

type Viewer = InstanceType<PdfLib['viewer']['PDFViewer']>;
type EventBus = InstanceType<PdfLib['viewer']['EventBus']>;
type LinkService = InstanceType<PdfLib['viewer']['PDFLinkService']>;

interface MatchesCount {
  current: number;
  total: number;
}

/** The message shown for a document that cannot be opened. */
export function pdfErrorMessage(error: unknown): string {
  const name = error instanceof Error || (typeof error === 'object' && error !== null) ? (error as { name?: string }).name : undefined;
  switch (name) {
    case 'InvalidPDFException':
      return 'This file is not a valid PDF, or it is damaged.';
    case 'PasswordException':
      return 'This PDF is protected by a password.';
    case 'ResponseException':
    case 'MissingPDFException':
    case 'UnexpectedResponseException':
      return 'The file could not be loaded from the server.';
    default:
      return error instanceof Error && error.message ? `The PDF could not be opened: ${error.message}` : 'The PDF could not be opened.';
  }
}

function findResult(state: number, lib: PdfLib): FindResult {
  const { FindState } = lib.viewer;
  switch (state) {
    case FindState.FOUND:
      return 'found';
    case FindState.NOT_FOUND:
      return 'not-found';
    case FindState.WRAPPED:
      return 'wrapped';
    case FindState.PENDING:
      return 'pending';
    default:
      return 'idle';
  }
}

interface Mounted {
  viewer: Viewer;
  eventBus: EventBus;
  linkService: LinkService;
  container: HTMLDivElement;
  task: PDFDocumentLoadingTask;
  cleanups: Array<() => void>;
}

export class PdfController {
  readonly #lib: PdfLib;
  readonly #url: string;
  readonly #opts: PdfControllerOptions;
  #state: PdfViewState = INITIAL;
  readonly #listeners = new Set<() => void>();
  #mounted: Mounted | null = null;
  #doc: PDFDocumentProxy | null = null;
  /** The page to show once the pages exist: the initial one, or one asked for while loading. */
  #pendingPage: number | null;
  readonly #accumulator = new ScaleAccumulator();

  constructor(lib: PdfLib, url: string, opts: PdfControllerOptions = {}) {
    this.#lib = lib;
    this.#url = url;
    this.#opts = opts;
    this.#pendingPage = opts.initialPage ?? null;
  }

  // ---------- state ----------

  readonly subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  readonly getState = (): PdfViewState => this.#state;

  #set(patch: Partial<PdfViewState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l();
  }

  /** The open document (for thumbnails), once loaded. */
  get document(): PDFDocumentProxy | null {
    return this.#doc;
  }

  /** The size of page `n` (1-based) at the current scale, once the viewer knows it. */
  pageSize(n: number): { width: number; height: number } | null {
    const view = this.#mounted?.viewer.getPageView(n - 1) as { viewport?: { width: number; height: number } } | undefined;
    return view?.viewport ? { width: view.viewport.width, height: view.viewport.height } : null;
  }

  /** A thumbnail of `page` was drawn: the viewer frees the page's resources unless it shows the page. */
  thumbnailRendered(page: number, pdfPage: unknown): void {
    this.#mounted?.eventBus.dispatch('thumbnailrendered', { source: this, pageNumber: page, pdfPage });
  }

  // ---------- lifecycle ----------

  /** Builds the viewer in `container` (absolutely positioned, scrolling) around `viewerEl` and opens the document. */
  mount(container: HTMLDivElement, viewerEl: HTMLDivElement): () => void {
    this.unmount();
    const { viewer: V, pdfjs } = this.#lib;
    const eventBus = new V.EventBus();
    const linkService = new V.PDFLinkService({ eventBus, externalLinkTarget: V.LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' });
    const findController = new V.PDFFindController({ eventBus, linkService });
    const viewer = new V.PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      l10n: pdfL10n as never,
      removePageBorders: true,
      textLayerMode: 1,
      // Links and comments; form fields show as drawn, never as inputs (a form cannot be saved here).
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      imageResourcesPath: PDFJS_IMAGES,
    });
    linkService.setViewer(viewer);
    const task = openPdf(this.#lib, this.#url);
    const mounted: Mounted = { viewer, eventBus, linkService, container, task, cleanups: [] };
    this.#mounted = mounted;
    this.#doc = null;
    this.#state = { ...INITIAL, find: NO_FIND };
    this.#set({});

    eventBus.on('pagesinit', () => this.#onPagesInit(mounted));
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      if (this.#mounted !== mounted) return;
      this.#set({ page: pageNumber });
      this.#opts.onPageChange?.(pageNumber);
    });
    eventBus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      if (this.#mounted === mounted) this.#set({ scale, scaleValue: presetValue ?? String(scale) });
    });
    eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: MatchesCount }) => {
      if (this.#mounted === mounted && this.#state.find.query) this.#set({ find: { ...this.#state.find, current: matchesCount.current, total: matchesCount.total } });
    });
    eventBus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount?: MatchesCount }) => {
      if (this.#mounted !== mounted || !this.#state.find.query) return;
      const find = { ...this.#state.find, result: findResult(state, this.#lib) };
      if (matchesCount) Object.assign(find, { current: matchesCount.current, total: matchesCount.total });
      this.#set({ find });
    });

    if (this.#opts.pinch) mounted.cleanups.push(attachPinch(container, { step: (s) => this.#zoomStep(s), end: () => this.#accumulator.reset() }));
    if (typeof ResizeObserver === 'function') {
      // A preset zoom follows the width: rotating the phone or resizing the sidebar refits the pages.
      let width = container.clientWidth;
      const observer = new ResizeObserver(() => {
        if (this.#mounted !== mounted || !this.#doc || container.clientWidth === width) return;
        width = container.clientWidth;
        const value = viewer.currentScaleValue;
        if ((PRESET_SCALES as readonly string[]).includes(value)) viewer.currentScaleValue = value;
      });
      observer.observe(container);
      mounted.cleanups.push(() => observer.disconnect());
    }

    if (this.#opts.askPassword) {
      const ask = this.#opts.askPassword;
      task.onPassword = (update: (password: string) => void, reason: number) => {
        void ask(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then((password) => {
          if (this.#mounted !== mounted) return;
          if (password === null) {
            this.#set({ status: 'error', error: 'This PDF is protected by a password.' });
            void task.destroy();
          } else {
            update(password);
          }
        });
      };
    }
    task.promise.then(
      (doc) => {
        if (this.#mounted !== mounted) return;
        this.#doc = doc;
        viewer.setDocument(doc);
        linkService.setDocument(doc, null);
        this.#set({ pages: doc.numPages });
      },
      (error: unknown) => {
        if (this.#mounted !== mounted || this.#state.status === 'error') return;
        this.#set({ status: 'error', error: pdfErrorMessage(error) });
      },
    );
    return () => this.unmount();
  }

  unmount(): void {
    const mounted = this.#mounted;
    if (!mounted) return;
    this.#mounted = null;
    this.#doc = null;
    for (const cleanup of mounted.cleanups) cleanup();
    try {
      mounted.viewer.setDocument(null as never);
      mounted.linkService.setDocument(null, null);
    } catch {
      // A viewer that never got its document has nothing to reset.
    }
    // Destroys the document in the shared worker; the worker itself stays for the next PDF.
    void mounted.task.destroy();
  }

  #onPagesInit(mounted: Mounted): void {
    if (this.#mounted !== mounted) return;
    const { viewer } = mounted;
    viewer.currentScaleValue = this.#opts.scaleValue ?? 'auto';
    const page = this.#pendingPage;
    this.#pendingPage = null;
    if (page !== null) viewer.currentPageNumber = Math.min(Math.max(1, page), viewer.pagesCount);
    // The page landmarks PDF.js would label through its own localization.
    for (const div of mounted.container.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
      div.setAttribute('aria-label', `Page ${div.dataset.pageNumber}`);
    }
    this.#set({ status: 'ready', page: viewer.currentPageNumber, scale: viewer.currentScale, scaleValue: viewer.currentScaleValue });
  }

  // ---------- navigation and zoom ----------

  goToPage(page: number): void {
    const mounted = this.#mounted;
    if (!mounted || this.#state.status !== 'ready') {
      this.#pendingPage = page;
      return;
    }
    mounted.viewer.currentPageNumber = Math.min(Math.max(1, Math.round(page)), mounted.viewer.pagesCount);
  }

  zoomIn(): void {
    if (this.#state.status === 'ready') this.#mounted?.viewer.increaseScale();
  }

  zoomOut(): void {
    if (this.#state.status === 'ready') this.#mounted?.viewer.decreaseScale();
  }

  /** A preset (`auto`, `page-width`, `page-fit`) or a scale such as `1.5`. */
  setScaleValue(value: string): void {
    if (this.#state.status === 'ready' && this.#mounted) this.#mounted.viewer.currentScaleValue = value;
  }

  #zoomStep(step: ZoomStep): void {
    const viewer = this.#mounted?.viewer;
    if (!viewer || this.#state.status !== 'ready') return;
    const current = viewer.currentScale;
    const target = this.#accumulator.add(current, step.factor);
    if (target === null && step.pan[0] === 0 && step.pan[1] === 0) return;
    viewer.updateScale({ drawingDelay: PINCH_DRAWING_DELAY_MS, scaleFactor: target === null ? 1 : target / current, origin: step.origin, pan: step.pan });
  }

  // ---------- find ----------

  /** Finds `query` (case- and accent-insensitive), highlighting every match. `again` moves to the next (or previous) one. */
  find(query: string, opts: { again?: boolean; previous?: boolean } = {}): void {
    const mounted = this.#mounted;
    if (!mounted) return;
    if (query === '') {
      this.clearFind();
      return;
    }
    const again = opts.again === true && query === this.#state.find.query;
    this.#set({ find: { ...(again ? this.#state.find : NO_FIND), query, result: 'pending' } });
    mounted.eventBus.dispatch('find', {
      source: this,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: opts.previous === true,
      matchDiacritics: false,
    });
  }

  clearFind(): void {
    this.#mounted?.eventBus.dispatch('findbarclose', { source: this });
    if (this.#state.find !== NO_FIND) this.#set({ find: NO_FIND });
  }
}
