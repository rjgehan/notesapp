// Outline of the open note from its live Lezer tree (DESIGN §6.6). Each heading has a star that
// bookmarks it (`[[Note#Heading]]`-style, DESIGN §6.23); it shows on hover, and always on touch.
import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { headingsFromState, type OutlineHeading } from '../../editor/outline';
import { isFileBookmarked, toggleFileBookmark, useBookmarks } from '../../features/bookmarkStore';
import { requestNoteScroll } from '../../features/noteScroll';
import { isNotePath } from '../../features/paths';
import { useUi } from '../../state/ui';
import { useDocumentSession, useSessionChangeCount } from '../../sync/useTextDocument';

const DEBOUNCE_MS = 300;

function Headings({ path }: { path: string }) {
  const session = useDocumentSession(path);
  const changeCount = useSessionChangeCount(session);
  const [headings, setHeadings] = useState<OutlineHeading[]>(() => headingsFromState(session.editorState));
  const { items: bookmarks } = useBookmarks();

  useEffect(() => {
    const timer = setTimeout(() => setHeadings(headingsFromState(session.editorState)), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [changeCount, session]);

  if (headings.length === 0) return <div className="panel-empty">No headings in this note.</div>;
  const minLevel = Math.min(...headings.map((h) => h.level));
  return (
    <ul className="outline" aria-label="Headings">
      {headings.map((h, i) => {
        const subpath = '#' + h.text;
        const starred = h.text !== '' && isFileBookmarked(bookmarks, session.path, subpath);
        return (
          <li key={`${h.line}-${i}`} className="outline-row">
            <button
              type="button"
              className="outline-item"
              style={{ paddingInlineStart: 12 + (h.level - minLevel) * 16 }}
              onClick={() => {
                // By line, not by heading text: repeated clicks, duplicate headings and headings
                // containing "#" all land on this exact heading.
                requestNoteScroll(session.path, h.line);
                useUi.getState().setSheetOpen(false);
              }}
            >
              {h.text || <span className="muted">(empty heading)</span>}
            </button>
            {h.text !== '' && (
              <button
                type="button"
                className={`icon-button outline-star${starred ? ' is-on' : ''}`}
                aria-pressed={starred}
                aria-label={starred ? `Remove the bookmark for “${h.text}”` : `Bookmark “${h.text}”`}
                title={starred ? 'Remove bookmark' : 'Bookmark this heading'}
                onClick={() => void toggleFileBookmark(session.path, subpath)}
              >
                <Star size={14} fill={starred ? 'currentColor' : 'none'} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function OutlinePanel({ activePath }: { activePath: string | null }) {
  if (!activePath || !isNotePath(activePath)) return <div className="panel-empty">Open a note to see its outline.</div>;
  return <Headings key={activePath} path={activePath} />;
}
