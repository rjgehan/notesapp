// The PDF view's page thumbnails (DESIGN §6.8.3): one button per page, each rendered when it scrolls
// near the list's viewport (thumbnails.ts), the current page marked and kept in view.
import type { PageViewport } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import type { PdfController } from './controller';
import { THUMBNAIL_WIDTH, ThumbnailRenderer } from './thumbnails';

/** A lazily created renderer, so a StrictMode remount (which destroyed the first) gets a fresh one. */
class RendererHolder {
  #renderer: ThumbnailRenderer<PageViewport> | null = null;
  readonly #controller: PdfController;

  constructor(controller: PdfController) {
    this.#controller = controller;
  }

  get(): ThumbnailRenderer<PageViewport> | null {
    const doc = this.#controller.document;
    if (!doc) return null;
    this.#renderer ??= new ThumbnailRenderer(doc, { onRendered: (n, page) => this.#controller.thumbnailRendered(n, page) });
    return this.#renderer;
  }

  destroy(): void {
    this.#renderer?.destroy();
    this.#renderer = null;
  }
}

type Visibility = (visible: boolean) => void;

/** One IntersectionObserver for the whole list; without the API (tests) every item counts as visible. */
class VisibilityWatcher {
  readonly #root: { current: HTMLElement | null };
  readonly #callbacks = new Map<Element, Visibility>();
  #observer: IntersectionObserver | null = null;

  constructor(root: { current: HTMLElement | null }) {
    this.#root = root;
  }

  observe(el: Element, fn: Visibility): () => void {
    if (typeof IntersectionObserver !== 'function') {
      fn(true);
      return () => {};
    }
    this.#observer ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) this.#callbacks.get(e.target)?.(e.isIntersecting);
      },
      { root: this.#root.current, rootMargin: '400px 0px' },
    );
    this.#callbacks.set(el, fn);
    this.#observer.observe(el);
    return () => {
      this.#callbacks.delete(el);
      this.#observer?.unobserve(el);
    };
  }

  disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#callbacks.clear();
  }
}

/** Letter-size until the viewer knows the page. */
const DEFAULT_ASPECT = 11 / 8.5;

function Thumb({ n, active, aspect, holder, watcher, onPick }: { n: number; active: boolean; aspect: number; holder: RendererHolder; watcher: VisibilityWatcher; onPick(n: number): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (url) return;
    let live = true;
    const unobserve = watcher.observe(ref.current!, (visible) => {
      const renderer = holder.get();
      if (!renderer) return;
      if (!visible) {
        renderer.cancel(n);
        return;
      }
      void renderer.request(n).then((u) => {
        if (live && u) setUrl(u);
      });
    });
    return () => {
      live = false;
      unobserve();
    };
  }, [n, url, holder, watcher]);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <li>
      <button
        ref={ref}
        type="button"
        className={`pdf-thumb${active ? ' is-active' : ''}`}
        aria-label={`Page ${n}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => onPick(n)}
      >
        <span className="pdf-thumb-image" style={{ aspectRatio: `1 / ${aspect}` }}>
          {url && <img src={url} alt="" draggable={false} />}
        </span>
        <span className="pdf-thumb-number">{n}</span>
      </button>
    </li>
  );
}

export function PdfThumbnails({ controller, pages, page, onPick }: { controller: PdfController; pages: number; page: number; onPick(n: number): void }) {
  const listRef = useRef<HTMLElement>(null);
  const [holder] = useState(() => new RendererHolder(controller));
  const [watcher] = useState(() => new VisibilityWatcher(listRef));

  useEffect(
    () => () => {
      watcher.disconnect();
      holder.destroy();
    },
    [holder, watcher],
  );

  const first = controller.pageSize(1);
  const fallback = first ? first.height / first.width : DEFAULT_ASPECT;
  const items = [];
  for (let n = 1; n <= pages; n++) {
    const size = controller.pageSize(n);
    items.push(<Thumb key={n} n={n} active={n === page} aspect={size ? size.height / size.width : fallback} holder={holder} watcher={watcher} onPick={onPick} />);
  }
  return (
    <nav className="pdf-thumbnails" aria-label="Pages" ref={listRef} style={{ ['--pdf-thumb-width' as string]: `${THUMBNAIL_WIDTH}px` }}>
      <ol>{items}</ol>
    </nav>
  );
}
