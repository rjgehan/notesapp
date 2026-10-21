// `![[file.pdf]]`, `![[file.pdf#page=3]]` and `![[file.pdf#height=400]]` (DESIGN §6.7, §6.8.3): the PDF
// viewer in a box of the note, scrolled to the page, as in Obsidian. PDF.js loads when the box comes near
// the screen, so a note with many PDF embeds costs nothing until it is read. The header opens the PDF at
// the page shown.
import { FileText } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../../api/endpoints';
import { noteRoute } from '../../features/paths';
import { useAppTheme } from '../excalidraw/theme';
import type { EmbedProps } from '../registry';
import { PdfController } from './controller';
import type { PdfLib } from './pdfLib';
import { darkPagesEnabled } from './prefs';
import { pageSubpath, parsePdfSubpath } from './subpath';
import { usePdfLib } from './usePdfLib';
import './pdfjs-viewer.css';
import './pdf.css';

export const DEFAULT_EMBED_HEIGHT = 600;

function EmbedHeader({ path, name, page, pages }: { path: string; name: string; page: number | null; pages: number }) {
  const sub = page ? pageSubpath(page) : null;
  return (
    <div className="pdf-embed-header">
      <FileText size={14} aria-hidden />
      <a className="internal-link" data-href={sub ? `${path}#${sub}` : path} href={noteRoute(path, sub)} title={`Open ${name}`}>
        {name}
      </a>
      {pages > 0 && page && (
        <span className="pdf-embed-page">
          Page {page} of {pages}
        </span>
      )}
    </div>
  );
}

function EmbedReader({ lib, path, name, url, initialPage }: { lib: PdfLib; path: string; name: string; url: string; initialPage: number | null }) {
  const [controller] = useState(() => new PdfController(lib, url, { initialPage, scaleValue: 'page-width' }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => controller.mount(containerRef.current!, viewerRef.current!), [controller]);

  return (
    <>
      <EmbedHeader path={path} name={name} page={state.status === 'ready' ? state.page : initialPage} pages={state.pages} />
      <div className="pdf-embed-stage">
        <div ref={containerRef} className="pdf-container" tabIndex={0} aria-label={name}>
          <div ref={viewerRef} className="pdfViewer" />
        </div>
        {state.status === 'loading' && <div className="pdf-status">Loading…</div>}
        {state.status === 'error' && (
          <div className="pdf-status" role="alert">
            {state.error}
          </div>
        )}
      </div>
    </>
  );
}

export default function PdfEmbed({ path, entry, subpath, width, height }: EmbedProps) {
  const target = parsePdfSubpath(subpath);
  const boxRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver !== 'function');
  const { lib, error } = usePdfLib(near);
  const theme = useAppTheme();
  const url = api.rawUrl(entry);

  useEffect(() => {
    if (near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(boxRef.current!);
    return () => observer.disconnect();
  }, [near]);

  return (
    <div
      ref={boxRef}
      className="pdf-embed-box"
      data-pdf-dark={theme === 'dark' && darkPagesEnabled() ? '' : undefined}
      style={{ height: height ?? target.height ?? DEFAULT_EMBED_HEIGHT, maxWidth: width }}
    >
      {lib ? (
        <EmbedReader key={url} lib={lib} path={path} name={entry.name} url={url} initialPage={target.page} />
      ) : (
        <>
          <EmbedHeader path={path} name={entry.name} page={target.page} pages={0} />
          <div className="pdf-embed-stage">
            <div className="pdf-status" role={error ? 'alert' : undefined}>
              {error ? `The PDF viewer could not be loaded: ${error}` : 'Loading…'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
