// The `markdown` view (DESIGN §6.8): the note editor and the reading view over one DocumentSession.
// A note in the Obsidian Kanban plugin's format shows as a board instead (DESIGN §6.8.4), or as
// Markdown with a bar that offers the board.
import { EditorView } from '@codemirror/view';
import { LayoutDashboard } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { useVaultSettings } from '../../api/hooks';
import { useWorkspaceScroller } from '../../components/layout/workspaceScroller';
import { findHeading, headingsFromState } from '../../editor/outline';
import { NoteEditor } from '../../editor/NoteEditor';
import { setSearchHighlight } from '../../editor/searchHighlight';
import { wantsNoteFocus } from '../../features/focus';
import { setNoteMode, setTopLineProbe, takePendingModeLine } from '../../features/noteMode';
import { useNoteScroll } from '../../features/noteScroll';
import { highlightTerms } from '../../features/searchTerms';
import { ReadingView } from '../../render/ReadingView';
import { scrollToLine, topVisibleLine } from '../../render/scroll';
import { flashBlock, highlightTermsIn } from '../../render/searchHits';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import { isKanbanText, KANBAN_PROBE_CHARS, setKanbanAsMarkdown, useKanbanAsMarkdown } from '../kanban/detect';
import type { FileViewProps } from '../registry';
import { NoteHeader } from './NoteHeader';
import { useHeadingRenameOffers } from './useHeadingRenameOffers';

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

const KanbanBoard = lazy(() => import('../kanban/KanbanBoard'));

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
  // Only the note's start is read (its frontmatter), so typing in a long note stays cheap.
  const kanban = useSyncExternalStore(session.subscribe, () => isKanbanText(session.editorState.doc.sliceString(0, KANBAN_PROBE_CHARS)));
  const asMarkdown = useKanbanAsMarkdown(session.path);

  // Where the newly shown mode should scroll: the mode switch's line, else a search hit's line.
  // Child views schedule the scroll in an animation frame, after this has run.
  useLayoutEffect(() => {
    const line = takePendingModeLine();
    if (line !== null) targetLine.current = line;
    if (mode === 'edit') reading.current = null;
    else editorView.current = null;
  }, [mode]);

  useLayoutEffect(() => {
    setTopLineProbe(() => {
      const el = scroller.current;
      if (!el) return null;
      if (mode === 'edit' && editorView.current) {
        const v = editorView.current;
        const block = v.lineBlockAtHeight(el.getBoundingClientRect().top - v.documentTop);
        return v.state.doc.lineAt(block.from).number - 1;
      }
      return reading.current ? topVisibleLine(reading.current, el) : null;
    });
    return () => setTopLineProbe(null);
  }, [mode, scroller]);

  useEffect(() => () => clearHighlights.current(), []);

  // A note that never loaded has no buffer to show (its error panel offers Try again).
  const ready = snapshot.loaded;
  // Renaming a heading by typing offers to update the links to it (DESIGN §6.24).
  useHeadingRenameOffers(session, ready && mode === 'edit');

  const scrollToTarget = useCallback(() => {
    const modeLine = targetLine.current;
    targetLine.current = null;
    const hitLine = modeLine === null && lineParam !== null && Number.isFinite(Number(lineParam)) ? Number(lineParam) : null;
    const line = modeLine ?? hitLine;
    clearHighlights.current();
    clearHighlights.current = () => {};
    if (mode === 'edit' && editorView.current) {
      const v = editorView.current;
      if (heading && modeLine === null) {
        const h = findHeading(headingsFromState(v.state), heading);
        if (h) return scrollEditorToLine(v, h.line);
      }
      if (line !== null) scrollEditorToLine(v, line);
      // A search hit flashes its line and highlights the query's terms.
      if (hitLine !== null) v.dispatch({ effects: setSearchHighlight.of({ terms, line: hitLine }) });
    } else if (mode === 'read' && reading.current) {
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
  }, [mode, heading, lineParam, terms]);

  // Heading links within the same note change only the hash; another hit changes only `?line=`.
  // Following the same link again is a new navigation (a new location key) and scrolls again.
  // A keyboard-initiated jump within the open note moves focus into it as well (DESIGN §6.19).
  useEffect(() => {
    if (!ready || (!heading && lineParam === null)) return;
    scrollToTarget();
    if (wantsNoteFocus()) {
      if (mode === 'edit') editorView.current?.focus();
      else reading.current?.focus({ preventScroll: true });
    }
  }, [heading, lineParam, ready, scrollToTarget, mode, location.key]);

  // Outline clicks scroll by source line (exact, and repeatable).
  const scrollRequest = useNoteScroll();
  const handledScroll = useRef(scrollRequest.seq);
  useEffect(() => {
    if (!ready || scrollRequest.seq === handledScroll.current || scrollRequest.path !== session.path) return;
    handledScroll.current = scrollRequest.seq;
    targetLine.current = scrollRequest.line;
    scrollToTarget();
  }, [scrollRequest, ready, session, scrollToTarget]);

  const toggle = () => setNoteMode(mode === 'edit' ? 'read' : 'edit');
  const board = ready && kanban && !asMarkdown;

  return (
    <div className={`markdown-view${settings.editor.readableLineLength && !board ? ' is-readable' : ''}${board ? ' is-kanban' : ''}`} data-mode={board ? 'board' : mode}>
      <NoteHeader
        path={session.path}
        snapshot={snapshot}
        mode={mode}
        modes={board ? [] : ['edit', 'read']}
        onToggleMode={toggle}
        editable={!NOT_RENAMEABLE.has(snapshot.status) && !snapshot.lossy}
      />
      {ready && kanban && asMarkdown && (
        <div className="kanban-switch" role="note">
          <span>This note is a Kanban board.</span>
          <button type="button" className="button button-small" onClick={() => setKanbanAsMarkdown(session.path, false)}>
            <LayoutDashboard size={14} aria-hidden /> Open as board
          </button>
        </div>
      )}
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
      ) : board ? (
        <Suspense
          fallback={
            <div className="view-loading" aria-busy="true">
              <div className="skeleton-line" />
            </div>
          }
        >
          <KanbanBoard session={session} readOnly={snapshot.status === 'readonly' || snapshot.lossy} onShowMarkdown={() => setKanbanAsMarkdown(session.path, true)} />
        </Suspense>
      ) : mode === 'edit' ? (
        <NoteEditor
          session={session}
          readOnly={snapshot.status === 'readonly' || snapshot.lossy}
          onToggleMode={toggle}
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
