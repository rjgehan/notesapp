// Page thumbnails for the PDF view's sidebar (DESIGN §6.8.3). Rendered on demand, newest request first
// (the pages the user just scrolled to), two at a time, into small JPEG images: a canvas per page
// would hold its pixels for as long as the list lives, which a 300-page file on the iPhone cannot afford.

export interface Size {
  width: number;
  height: number;
}

/** The parts of PDF.js's page proxy a thumbnail needs; `V` is its viewport type. */
export interface ThumbnailPage<V extends Size = Size> {
  getViewport(params: { scale: number }): V;
  render(params: { canvas: HTMLCanvasElement; viewport: V }): { promise: Promise<unknown> };
}

export interface ThumbnailSource<V extends Size = Size> {
  getPage(n: number): Promise<ThumbnailPage<V>>;
}

/** Thumbnail width in CSS pixels. */
export const THUMBNAIL_WIDTH = 120;
const CONCURRENCY = 2;

interface Job {
  page: number;
  resolve(url: string | null): void;
}

export class ThumbnailRenderer<V extends Size = Size> {
  readonly #source: ThumbnailSource<V>;
  readonly #pixelWidth: number;
  readonly #urls = new Map<number, Promise<string | null>>();
  readonly #created: string[] = [];
  #queue: Job[] = [];
  #running = 0;
  #destroyed = false;

  readonly #onRendered: ((page: number, pdfPage: ThumbnailPage<V>) => void) | undefined;

  /** `onRendered` lets the viewer free a page it does not show (PDF.js's `thumbnailrendered` event). */
  constructor(source: ThumbnailSource<V>, opts: { width?: number; pixelRatio?: number; onRendered?(page: number, pdfPage: ThumbnailPage<V>): void } = {}) {
    this.#source = source;
    const ratio = opts.pixelRatio ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    this.#pixelWidth = Math.round((opts.width ?? THUMBNAIL_WIDTH) * Math.min(ratio, 2));
    this.#onRendered = opts.onRendered;
  }

  /** An object URL of page `n`'s image (null if it could not be rendered); the same promise for repeated requests. */
  request(page: number): Promise<string | null> {
    let url = this.#urls.get(page);
    if (!url) {
      url = new Promise<string | null>((resolve) => {
        this.#queue.push({ page, resolve });
      });
      this.#urls.set(page, url);
      this.#pump();
    }
    return url;
  }

  /** Drops a request that has not started (its thumbnail scrolled out of view); a later request queues it again. */
  cancel(page: number): void {
    const index = this.#queue.findIndex((j) => j.page === page);
    if (index < 0) return;
    const [job] = this.#queue.splice(index, 1);
    this.#urls.delete(page);
    job.resolve(null);
  }

  destroy(): void {
    this.#destroyed = true;
    for (const job of this.#queue) job.resolve(null);
    this.#queue = [];
    for (const url of this.#created) URL.revokeObjectURL(url);
    this.#created.length = 0;
  }

  #pump(): void {
    while (!this.#destroyed && this.#running < CONCURRENCY && this.#queue.length > 0) {
      const job = this.#queue.pop()!;
      this.#running++;
      void this.#render(job.page)
        .catch(() => null)
        .then((url) => {
          this.#running--;
          job.resolve(url);
          this.#pump();
        });
    }
  }

  async #render(n: number): Promise<string | null> {
    const page = await this.#source.getPage(n);
    if (this.#destroyed) return null;
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: this.#pixelWidth / natural.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    try {
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob || this.#destroyed) return null;
      const url = URL.createObjectURL(blob);
      this.#created.push(url);
      return url;
    } finally {
      // Free the bitmap now; iOS counts canvas memory per page, not per visible element.
      canvas.width = 0;
      canvas.height = 0;
      this.#onRendered?.(n, page);
    }
  }
}
