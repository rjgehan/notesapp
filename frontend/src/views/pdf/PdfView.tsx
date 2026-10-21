// The PDF view (ROADMAP item 32, DESIGN §6.8.3): PDF.js renders the pages inside the app, on the iPhone
// too, with a toolbar (thumbnails, page, zoom, find, dark pages, download), pinch zoom and selectable
// text. A link's `#page=N` opens that page; otherwise the page last read on this device. This module is
// the lazy chunk that carries PDF.js (through pdfLib.ts).
import { ChevronDown, ChevronUp, Download, ExternalLink, Moon, PanelLeft, Search, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { useLocation } from 'react-router';
import { api } from '../../api/endpoints';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { wantsNoteFocus } from '../../features/focus';
import { promptText } from '../../state/dialogs';
import { useAppTheme } from '../excalidraw/theme';
import type { FileViewProps } from '../registry';
import { setActivePdf } from './active';
import { PdfController, type PdfViewState } from './controller';
import type { PdfLib } from './pdfLib';
import { PdfThumbnails } from './PdfThumbnails';
import { darkPagesEnabled, lastPage, rememberPage, setDarkPages } from './prefs';
import { parsePdfSubpath } from './subpath';
import { usePdfLib } from './usePdfLib';
import './pdfjs-viewer.css';
import './pdf.css';

const ZOOM_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['auto', 'Automatic'],
  ['page-width', 'Page width'],
  ['page-fit', 'Whole page'],
  ['0.5', '50 %'],
  ['0.75', '75 %'],
  ['1', '100 %'],
  ['1.25', '125 %'],
  ['1.5', '150 %'],
  ['2', '200 %'],
  ['3', '300 %'],
  ['4', '400 %'],
];

function askPassword(retry: boolean): Promise<string | null> {
  return promptText({
    title: 'Password-protected PDF',
    label: retry ? 'Wrong password. Try again' : 'Password',
    value: '',
    confirmLabel: 'Open',
    secret: true,
  });
}

function PageInput({ page, pages, onGo }: { page: number; pages: number; onGo(page: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const n = Number(draft);
    if (draft && Number.isInteger(n) && n >= 1 && n <= pages && n !== page) onGo(n);
    setDraft(null);
  };
  return (
    <input
      className="pdf-page-input"
      type="text"
      inputMode="numeric"
      enterKeyHint="go"
      aria-label={`Page (1–${pages})`}
      disabled={pages === 0}
      value={draft ?? (pages ? String(page) : '')}
      onFocus={(e) => {
        setDraft(String(page));
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(String(page));
          e.currentTarget.blur();
        }
      }}
      onBlur={commit}
    />
  );
}

function ZoomSelect({ state, onChange }: { state: PdfViewState; onChange(value: string): void }) {
  const known = ZOOM_CHOICES.some(([value]) => value === state.scaleValue);
  return (
    <select className="pdf-zoom-select" aria-label="Zoom" disabled={state.status !== 'ready'} value={known ? state.scaleValue : 'custom'} onChange={(e) => onChange(e.target.value)}>
      {!known && (
        <option value="custom" disabled>
          {Math.round(state.scale * 100)} %
        </option>
      )}
      {ZOOM_CHOICES.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

function findLabel(state: PdfViewState): string {
  const { find } = state;
  if (!find.query) return '';
  if (find.result === 'pending' && find.total === 0) return 'Searching…';
  if (find.result === 'not-found' || (find.total === 0 && find.result !== 'pending')) return 'No results';
  return `${find.current} of ${find.total}${find.result === 'pending' ? '…' : ''}`;
}

function PdfReader({ lib, path, entry, url }: FileViewProps & { lib: PdfLib; url: string }) {
  const location = useLocation();
  // `#page=N` from a link, or `?page=N` from a search hit in the PDF's text (API.md §12.1).
  const hashPage = parsePdfSubpath(location.hash).page ?? parsePdfSubpath(location.search).page;
  const [controller] = useState(() => new PdfController(lib, url, { initialPage: hashPage ?? lastPage(path), pinch: true, askPassword }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const breakpoint = useBreakpoint();
  const theme = useAppTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [thumbsOpen, setThumbsOpen] = useState(false);
  const [darkPages, setDark] = useState(darkPagesEnabled);

  // Reopening the PDF on this device continues at this page.
  useEffect(() => {
    if (state.status === 'ready') rememberPage(path, state.page);
  }, [path, state.page, state.status]);

  useEffect(() => {
    const unmount = controller.mount(containerRef.current!, viewerRef.current!);
    // Opened from the keyboard: the arrow keys, Page Down and Space scroll the pages at once.
    if (wantsNoteFocus()) containerRef.current?.focus({ preventScroll: true });
    return unmount;
  }, [controller]);

  // A link to another page of the PDF that is already open (the route's hash changes, the view stays).
  useEffect(() => {
    if (hashPage !== null) controller.goToPage(hashPage);
  }, [controller, hashPage, location.key]);

  const openFind = useCallback(() => {
    flushSync(() => setFindOpen(true));
    findRef.current?.focus();
    findRef.current?.select();
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    controller.clearFind();
    containerRef.current?.focus({ preventScroll: true });
  }, [controller]);

  const toggleThumbnails = useCallback(() => setThumbsOpen((open) => !open), []);
  const toggleDarkPages = useCallback(() => {
    setDark((on) => {
      setDarkPages(!on);
      return !on;
    });
  }, []);

  useEffect(() => setActivePdf({ path, controller, openFind, toggleThumbnails, toggleDarkPages }), [path, controller, openFind, toggleThumbnails, toggleDarkPages]);

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      controller.find(query, { again: true, previous: e.shiftKey });
    }
  };

  const phone = breakpoint === 'phone';
  const ready = state.status === 'ready';
  const dimmed = theme === 'dark' && darkPages;
  const label = findLabel(state);

  return (
    <div className="pdf-view" data-pdf-dark={dimmed ? '' : undefined}>
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF">
        <button
          type="button"
          className="icon-button"
          aria-pressed={thumbsOpen}
          aria-label="Page thumbnails"
          title="Page thumbnails"
          disabled={!ready}
          onClick={toggleThumbnails}
        >
          <PanelLeft size={16} />
        </button>
        {!phone && (
          <span className="pdf-toolbar-title" title={path}>
            {entry.name}
          </span>
        )}
        {/* Phones scroll and pinch; the page field, zoom presets and find fit their width. */}
        <span className="pdf-toolbar-group">
          {!phone && (
            <button type="button" className="icon-button" aria-label="Previous page" title="Previous page" disabled={!ready || state.page <= 1} onClick={() => controller.goToPage(state.page - 1)}>
              <ChevronUp size={16} />
            </button>
          )}
          <PageInput page={state.page} pages={state.pages} onGo={(n) => controller.goToPage(n)} />
          <span className="pdf-page-count">/ {state.pages || '–'}</span>
          {!phone && (
            <button type="button" className="icon-button" aria-label="Next page" title="Next page" disabled={!ready || state.page >= state.pages} onClick={() => controller.goToPage(state.page + 1)}>
              <ChevronDown size={16} />
            </button>
          )}
        </span>
        <span className="pdf-toolbar-group">
          {!phone && (
            <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" disabled={!ready} onClick={() => controller.zoomOut()}>
              <ZoomOut size={16} />
            </button>
          )}
          <ZoomSelect state={state} onChange={(v) => controller.setScaleValue(v)} />
          {!phone && (
            <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" disabled={!ready} onClick={() => controller.zoomIn()}>
              <ZoomIn size={16} />
            </button>
          )}
        </span>
        <span className="pdf-toolbar-end">
          <button type="button" className="icon-button" aria-pressed={findOpen} aria-label="Find in PDF" title="Find in PDF" disabled={!ready} onClick={findOpen ? closeFind : openFind}>
            <Search size={16} />
          </button>
          {theme === 'dark' && (
            <button type="button" className="icon-button" aria-pressed={darkPages} aria-label="Dark pages" title="Dark pages" onClick={toggleDarkPages}>
              <Moon size={16} />
            </button>
          )}
          {/* On phones "Download current file" is in the command palette (⋯). */}
          {!phone && (
            <>
              <a className="icon-button" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in the browser's viewer" title="Open in the browser's viewer">
                <ExternalLink size={16} />
              </a>
              <a className="icon-button" href={api.rawUrl(entry, { download: true })} download={entry.name} aria-label="Download" title="Download">
                <Download size={16} />
              </a>
            </>
          )}
        </span>
      </div>
      {findOpen && (
        <div
          className="pdf-findbar"
          role="search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              closeFind();
            }
          }}
        >
          <input
            ref={findRef}
            className="pdf-find-input"
            type="search"
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              controller.find(e.target.value);
            }}
            onKeyDown={onFindKey}
          />
          <span className="pdf-find-count" aria-live="polite">
            {label}
          </span>
          <button type="button" className="icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!state.find.total} onClick={() => controller.find(query, { again: true, previous: true })}>
            <ChevronUp size={16} />
          </button>
          <button type="button" className="icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!state.find.total} onClick={() => controller.find(query, { again: true })}>
            <ChevronDown size={16} />
          </button>
          <button type="button" className="icon-button" aria-label="Close find" title="Close (Escape)" onClick={closeFind}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="pdf-body">
        {thumbsOpen && ready && (
          <PdfThumbnails
            controller={controller}
            pages={state.pages}
            page={state.page}
            onPick={(n) => {
              controller.goToPage(n);
              if (phone) setThumbsOpen(false);
            }}
          />
        )}
        <div className="pdf-stage">
          <div ref={containerRef} className="pdf-container" tabIndex={0} aria-label={entry.name}>
            <div ref={viewerRef} className="pdfViewer" />
          </div>
          {state.status === 'loading' && (
            <div className="pdf-status" aria-busy="true">
              Loading…
            </div>
          )}
          {state.status === 'error' && (
            <div className="pdf-status error-panel" role="alert">
              <p className="error-panel-title">{state.error}</p>
              <a className="button" href={api.rawUrl(entry, { download: true })} download={entry.name}>
                <Download size={15} aria-hidden /> Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PdfView(props: FileViewProps) {
  const { lib, error, retry } = usePdfLib();
  const url = api.rawUrl(props.entry);
  if (error) {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel-title">The PDF viewer could not be loaded.</p>
        <p className="error-panel-detail">{error}</p>
        <button type="button" className="button" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!lib) {
    return (
      <div className="view-loading" aria-busy="true">
        <div className="skeleton-line" />
      </div>
    );
  }
  // A new version of the file (another device replaced it) is a new document.
  return <PdfReader key={url} lib={lib} url={url} {...props} />;
}
