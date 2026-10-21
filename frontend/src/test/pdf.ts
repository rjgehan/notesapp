// Test doubles for PDF.js (the real library needs a browser with canvas and workers): just enough of
// pdfjs-dist and its viewer module for the controller, the view and the embed.
import type { PdfLib } from '../views/pdf/pdfLib';

type Handler = (e: Record<string, unknown>) => void;

export class FakeEventBus {
  readonly handlers = new Map<string, Handler[]>();
  readonly dispatched: Array<{ name: string; data: Record<string, unknown> }> = [];

  on(name: string, fn: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }

  off(name: string, fn: Handler): void {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((h) => h !== fn));
  }

  dispatch(name: string, data: Record<string, unknown>): void {
    this.dispatched.push({ name, data });
    for (const h of this.handlers.get(name) ?? []) h(data);
  }
}

export class FakeDocument {
  destroyed = false;
  readonly numPages: number;

  constructor(numPages: number) {
    this.numPages = numPages;
  }
  getPage(n: number) {
    return Promise.resolve({
      pageNumber: n,
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
      render: () => ({ promise: Promise.resolve() }),
    });
  }
}

export class FakeLoadingTask {
  onPassword: ((update: (password: string) => void, reason: number) => void) | null = null;
  destroyed = false;
  readonly promise: Promise<FakeDocument>;
  resolve!: (doc: FakeDocument) => void;
  reject!: (e: unknown) => void;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }
}

export class FakeViewer {
  static instances: FakeViewer[] = [];
  readonly eventBus: FakeEventBus;
  readonly container: HTMLDivElement;
  document: FakeDocument | null = null;
  pagesCount = 0;
  currentScale = 1;
  #page = 1;
  #scaleValue = 'auto';
  readonly updates: Array<Record<string, unknown>> = [];

  constructor(opts: { container: HTMLDivElement; viewer: HTMLDivElement; eventBus: FakeEventBus }) {
    this.eventBus = opts.eventBus;
    this.container = opts.container;
    FakeViewer.instances.push(this);
  }

  setDocument(doc: FakeDocument | null): void {
    this.document = doc;
    this.pagesCount = doc?.numPages ?? 0;
  }

  /** What PDF.js does once the pages exist. */
  initPages(): void {
    this.eventBus.dispatch('pagesinit', { source: this });
  }

  get currentPageNumber(): number {
    return this.#page;
  }

  set currentPageNumber(n: number) {
    this.#page = n;
    this.eventBus.dispatch('pagechanging', { source: this, pageNumber: n });
  }

  get currentScaleValue(): string {
    return this.#scaleValue;
  }

  set currentScaleValue(v: string) {
    this.#scaleValue = v;
    const scale = Number(v) > 0 ? Number(v) : v === 'page-fit' ? 0.7 : 0.9;
    this.currentScale = scale;
    this.eventBus.dispatch('scalechanging', { source: this, scale, presetValue: Number(v) > 0 ? undefined : v });
  }

  updateScale(opts: { scaleFactor: number }): void {
    this.updates.push(opts);
    this.currentScale = Math.round(this.currentScale * opts.scaleFactor * 100) / 100;
    this.#scaleValue = String(this.currentScale);
    this.eventBus.dispatch('scalechanging', { source: this, scale: this.currentScale });
  }

  increaseScale(): void {
    this.updateScale({ scaleFactor: 1.1 });
  }

  decreaseScale(): void {
    this.updateScale({ scaleFactor: 1 / 1.1 });
  }

  getPageView(i: number) {
    return i < this.pagesCount ? { viewport: { width: 612 * this.currentScale, height: 792 * this.currentScale } } : undefined;
  }
}

export interface FakeLib {
  lib: PdfLib;
  tasks: FakeLoadingTask[];
}

export function fakePdfLib(): FakeLib {
  const tasks: FakeLoadingTask[] = [];
  FakeViewer.instances = [];
  const viewer = {
    EventBus: FakeEventBus,
    PDFLinkService: class {
      document: unknown = null;
      setViewer() {}
      setDocument(doc: unknown) {
        this.document = doc;
      }
    },
    PDFFindController: class {},
    PDFViewer: FakeViewer,
    LinkTarget: { NONE: 0, SELF: 1, BLANK: 2 },
    FindState: { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 },
  };
  const pdfjs = {
    AnnotationMode: { ENABLE: 1 },
    AnnotationEditorType: { DISABLE: -1 },
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    getDocument: ({ url }: { url: string }) => {
      const task = new FakeLoadingTask(url);
      tasks.push(task);
      return task;
    },
  };
  return { lib: { pdfjs, viewer, worker: {} } as unknown as PdfLib, tasks };
}
