// The `markdown` view (DESIGN §6.8): the note editor (Live Preview, source or locked, §6.6.1) and
// the reading view over one DocumentSession.
import { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router';
import { useVaultSettings } from '../../api/hooks';
import { useWorkspaceScroller } from '../../components/layout/workspaceScroller';
import { findHeading, headingsFromState } from '../../editor/outline';
import { NoteEditor } from '../../editor/NoteEditor';
import { setSearchHighlight } from '../../editor/searchHighlight';
import { wantsNoteFocus } from '../../features/focus';
import { setTopLineProbe, takePendingModeLine, toggleNoteMode } from '../../features/noteMode';
import { useNoteScroll } from '../../features/noteScroll';
import { highlightTerms } from '../../features/searchTerms';
import { ReadingView } from '../../render/ReadingView';
import { scrollToLine, topVisibleLine } from '../../render/scroll';
import { flashBlock, highlightTermsIn } from '../../render/searchHits';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import type { FileViewProps } from '../registry';
import { NoteHeader } from './NoteHeader';

function decodeHash(hash: string): string | null {
  if (!hash || hash === '#') return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

/** Scrolls an editor so that 0-based `line` is at the top of the workspace. */
function scrollEditorToLine(view: EditorView, line: number): void {
  const n = Math.min(Math.max(line + 1, 1), view.state.doc.lines);
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'start' }) });
}

const NOT_RENAMEABLE = new Set(['loading', 'readonly', 'deleted']);

export default function MarkdownView({ path, mode }: FileViewProps) {
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  const settings = useVaultSettings();
  const scroller = useWorkspaceScroller();
  const location = useLocation();
  const editorView = useRef<EditorView | null>(null);
  const reading = useRef<HTMLElement | null>(null);
  const clearHighlights = useRef<() => void>(() => {});
  const heading = decodeHash(location.hash);
  const params = new URLSearchParams(location.search);
  const lineParam = params.get('line');
  const query = params.get('q') ?? '';
  const terms = useMemo(() => highlightTerms(query), [query]);
  const targetLine = useRef<number | null>(null);
  // Live Preview, source and locked are all the editor; `read` is the v1 reading view.
  const editing = mode !== 'read';

  // Where the newly shown mode should scroll: the mode switch's line, else a search hit's line.
  // Child views schedule the scroll in an animation frame, after this has run.
  useLayoutEffect(() => {
    const line = takePendingModeLine();
    if (line !== null) targetLine.current = line;
    if (editing) reading.current = null;
    else editorView.current = null;
  }, [editing]);

  useLayoutEffect(() => {
    setTopLineProbe(() => {
      const el = scroller.current;
      if (!el) return null;
      if (editing && editorView.current) {
        const v = editorView.current;
        const block = v.lineBlockAtHeight(el.getBoundingClientRect().top - v.documentTop);
        return v.state.doc.lineAt(block.from).number - 1;
      }
      return reading.current ? topVisibleLine(reading.current, el) : null;
    });
    return () => setTopLineProbe(null);
  }, [editing, scroller]);

  useEffect(() => () => clearHighlights.current(), []);

  // A note that never loaded has no buffer to show (its error panel offers Try again).
  const ready = snapshot.loaded;

  const scrollToTarget = useCallback(() => {
    const modeLine = targetLine.current;
    targetLine.current = null;
    const hitLine = modeLine === null && lineParam !== null && Number.isFinite(Number(lineParam)) ? Number(lineParam) : null;
    const line = modeLine ?? hitLine;
    clearHighlights.current();
    clearHighlights.current = () => {};
    if (editing && editorView.current) {
      const v = editorView.current;
      if (heading && modeLine === null) {
        const h = findHeading(headingsFromState(v.state), heading);
        if (h) return scrollEditorToLine(v, h.line);
      }
      if (line !== null) scrollEditorToLine(v, line);
      // A search hit flashes its line and highlights the query's terms.
      if (hitLine !== null) v.dispatch({ effects: setSearchHighlight.of({ terms, line: hitLine }) });
    } else if (!editing && reading.current) {
      const container = reading.current;
      if (heading && modeLine === null) {
        const blocks = [...container.querySelectorAll<HTMLElement>('[data-heading]')].filter((el) => !el.closest('[data-embed-root]'));
        const hit = findHeading(blocks.map((el) => ({ el, text: el.dataset.heading ?? '' })), heading);
        if (hit) return hit.el.scrollIntoView({ block: 'start' });
      }
      if (line !== null) {
        const block = scrollToLine(container, line);
        if (hitLine !== null && block) {
          flashBlock(block);
          clearHighlights.current = highlightTermsIn(container, terms);
        }
      }
    }
  }, [editing, heading, lineParam, terms]);

  // Heading links within the same note change only the hash; another hit changes only `?line=`.
  // Following the same link again is a new navigation (a new location key) and scrolls again.
  // A keyboard-initiated jump within the open note moves focus into it as well (DESIGN §6.19).
  useEffect(() => {
    if (!ready || (!heading && lineParam === null)) return;
    scrollToTarget();
    if (wantsNoteFocus()) {
      if (editing) editorView.current?.focus();
      else reading.current?.focus({ preventScroll: true });
    }
  }, [heading, lineParam, ready, scrollToTarget, editing, location.key]);

  // Outline clicks scroll by source line (exact, and repeatable).
  const scrollRequest = useNoteScroll();
  const handledScroll = useRef(scrollRequest.seq);
  useEffect(() => {
    if (!ready || scrollRequest.seq === handledScroll.current || scrollRequest.path !== session.path) return;
    handledScroll.current = scrollRequest.seq;
    targetLine.current = scrollRequest.line;
    scrollToTarget();
  }, [scrollRequest, ready, session, scrollToTarget]);

  return (
    <div className={`markdown-view${settings.editor.readableLineLength ? ' is-readable' : ''}`} data-mode={mode}>
      <NoteHeader
        path={session.path}
        snapshot={snapshot}
        mode={mode}
        editable={!NOT_RENAMEABLE.has(snapshot.status) && !snapshot.lossy}
      />
      {snapshot.status === 'loading' ? (
        <div className="view-loading" aria-busy="true">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
        </div>
      ) : !ready ? (
        <div className="error-panel" role="alert">
          <p className="error-panel-title">This note could not be opened.</p>
          <p className="error-panel-detail">{snapshot.error}</p>
          {snapshot.retryAt !== null && <p className="error-panel-detail muted">Retrying automatically…</p>}
          <button type="button" className="button" onClick={() => void session.reload()}>
            Try again
          </button>
        </div>
      ) : editing ? (
        <NoteEditor
          session={session}
          readOnly={snapshot.status === 'readonly' || snapshot.lossy}
          preview={mode === 'source' ? undefined : mode === 'locked' ? 'locked' : 'live'}
          onToggleMode={toggleNoteMode}
          onView={(v) => {
            editorView.current = v;
            requestAnimationFrame(scrollToTarget);
          }}
        />
      ) : (
        <ReadingView
          session={session}
          onRendered={(el) => {
            const first = reading.current === null;
            reading.current = el;
            if (!first) return;
            if (wantsNoteFocus()) el.focus({ preventScroll: true });
            requestAnimationFrame(scrollToTarget);
          }}
        />
      )}
      {snapshot.lossy && (
        <p className="note-warning" role="note">
          This file contains invalid UTF-8 and is shown read-only, so the damaged bytes are never written back.
        </p>
      )}
    </div>
  );
}
