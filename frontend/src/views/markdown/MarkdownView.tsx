// The `markdown` view (DESIGN §6.8): the note editor over one DocumentSession, in Live Preview,
// source or locked mode (§6.6.1). Locked Live Preview is also the reading view (ROADMAP 10b).
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
import { isEditingMode, setTopLineProbe, takePendingModeLine, toggleNoteMode } from '../../features/noteMode';
import { useNoteScroll } from '../../features/noteScroll';
import { highlightTerms } from '../../features/searchTerms';
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
  // The editor (remounted for the new mode) schedules the scroll in an animation frame, after this.
  useLayoutEffect(() => {
    const line = takePendingModeLine();
    if (line !== null) targetLine.current = line;
  }, [mode]);

  useLayoutEffect(() => {
    setTopLineProbe(() => {
      const el = scroller.current;
      const v = editorView.current;
      if (!el || !v) return null;
      const block = v.lineBlockAtHeight(el.getBoundingClientRect().top - v.documentTop);
      return v.state.doc.lineAt(block.from).number - 1;
    });
    return () => setTopLineProbe(null);
  }, [scroller]);

  // A note that never loaded has no buffer to show (its error panel offers Try again).
  const ready = snapshot.loaded;
  // Renaming a heading by typing offers to update the links to it (DESIGN §6.24).
  useHeadingRenameOffers(session, ready && isEditingMode(mode));

  const scrollToTarget = useCallback(() => {
    const modeLine = targetLine.current;
    targetLine.current = null;
    const hitLine = modeLine === null && lineParam !== null && Number.isFinite(Number(lineParam)) ? Number(lineParam) : null;
    const line = modeLine ?? hitLine;
    const v = editorView.current;
    if (!v) return;
    if (heading && modeLine === null) {
      const h = findHeading(headingsFromState(v.state), heading);
      if (h) return scrollEditorToLine(v, h.line);
    }
    if (line !== null) scrollEditorToLine(v, line);
    // A search hit flashes its line and highlights the query's terms.
    if (hitLine !== null) v.dispatch({ effects: setSearchHighlight.of({ terms, line: hitLine }) });
  }, [heading, lineParam, terms]);

  // Heading links within the same note change only the hash; another hit changes only `?line=`.
  // Following the same link again is a new navigation (a new location key) and scrolls again.
  // A keyboard-initiated jump within the open note moves focus into it as well (DESIGN §6.19).
  useEffect(() => {
    if (!ready || (!heading && lineParam === null)) return;
    scrollToTarget();
    if (wantsNoteFocus()) editorView.current?.focus();
  }, [heading, lineParam, ready, scrollToTarget, location.key]);

  // Outline clicks scroll by source line (exact, and repeatable).
  const scrollRequest = useNoteScroll();
  const handledScroll = useRef(scrollRequest.seq);
  useEffect(() => {
    if (!ready || scrollRequest.seq === handledScroll.current || scrollRequest.path !== session.path) return;
    handledScroll.current = scrollRequest.seq;
    targetLine.current = scrollRequest.line;
    scrollToTarget();
  }, [scrollRequest, ready, session, scrollToTarget]);

  const board = ready && kanban && !asMarkdown;

  return (
    <div className={`markdown-view${settings.editor.readableLineLength && !board ? ' is-readable' : ''}${board ? ' is-kanban' : ''}`} data-mode={board ? 'board' : mode}>
      <NoteHeader
        path={session.path}
        snapshot={snapshot}
        mode={mode}
        controls={!board}
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
      ) : (
        <NoteEditor
          session={session}
          readOnly={snapshot.status === 'readonly' || snapshot.lossy}
          preview={mode === 'source' ? undefined : mode === 'live' || mode === 'edit' ? 'live' : 'locked'}
          onToggleMode={toggleNoteMode}
          onView={(v) => {
            editorView.current = v;
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
