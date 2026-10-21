// Full-text search (DESIGN §6.4, API.md §12.1), shared by the desktop panel (query in zustand,
// never in the route) and the phone search page (`/search?q=`). Input is debounced by 200 ms.
// Saved searches (API.md §12.4) are listed while the field is empty and saved from the toolbar.
import { ArrowDownWideNarrow, BookmarkCheck, BookmarkPlus, FileText, FileType, Pencil, Search, Star, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useSavedSearches, useSearch } from '../../api/hooks';
import type { SavedSearch, SearchHit, SearchResponse, SearchSort } from '../../api/types';
import { findSearchBookmarks } from '../../features/bookmarks';
import { toggleSearchBookmark, useBookmarks } from '../../features/bookmarkStore';
import { toastError } from '../../features/errors';
import { afterOpen, isKeyboardClick } from '../../features/focus';
import { navigateTo } from '../../features/navigation';
import { folderOf } from '../../features/paths';
import { addSavedSearch, deleteSavedSearch, findSavedSearch, renameSavedSearch } from '../../features/savedSearches';
import { hitRoute } from '../../features/searchLinks';
import { confirmAction, promptText } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import { HighlightedText } from '../HighlightedText';

const DEBOUNCE_MS = 200;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function Hit({ hit, highlight }: { hit: SearchHit; highlight: string }) {
  const open = (match: { line: number; page: number | null } | null, e: { detail: number }) => {
    useUi.getState().setDrawerOpen(false);
    afterOpen(hit.path, isKeyboardClick(e));
    navigateTo(hitRoute(hit, match, highlight));
  };
  const folder = folderOf(hit.path);
  const Icon = hit.kind === 'pdf' ? FileType : FileText;
  return (
    <li className="search-hit">
      <button type="button" className="search-hit-title" onClick={(e) => open(hit.matches[0] ?? null, e)} title={hit.path}>
        <Icon size={14} aria-hidden />
        <span className="search-hit-name">
          <HighlightedText text={hit.basename} ranges={hit.titleRanges} />
        </span>
        {hit.kind === 'pdf' && <span className="search-hit-kind">PDF</span>}
        {folder && <span className="search-hit-folder">{folder}</span>}
      </button>
      {hit.matches.length > 0 && (
        <ul className="search-matches">
          {hit.matches.map((m) => (
            <li key={m.line}>
              <button type="button" className="search-match" onClick={(e) => open(m, e)}>
                {m.page !== null && <span className="search-match-page">p. {m.page}</span>}
                <HighlightedText text={m.text} ranges={m.ranges} />
              </button>
            </li>
          ))}
          {hit.moreMatches > 0 && (
            <li className="search-more">
              {hit.moreMatches} more {hit.moreMatches === 1 ? 'match' : 'matches'}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** "Including similar words" for a response that used typo tolerance, with a way back to exact words. */
function Corrections({ data, onExact }: { data: SearchResponse; onExact(): void }) {
  if (data.corrections.length === 0) return null;
  return (
    <div className="search-corrections" role="status">
      Including similar words:{' '}
      {data.corrections.map((c, i) => (
        <span key={c.term}>
          {i > 0 && ', '}
          <s>{c.term}</s> → {c.replacements.join(', ')}
        </span>
      ))}
      .{' '}
      <button type="button" className="link-button" onClick={onExact}>
        Exact words only
      </button>
    </div>
  );
}

function SavedSearches({ searches, onPick }: { searches: SavedSearch[]; onPick(s: SavedSearch): void }) {
  const rename = async (s: SavedSearch) => {
    const name = await promptText({ title: 'Rename saved search', label: 'Name', value: s.name, confirmLabel: 'Rename', validate: (v) => (v.trim() ? null : 'Enter a name') });
    if (name === null || name.trim() === s.name) return;
    try {
      await renameSavedSearch(s.id, name);
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async (s: SavedSearch) => {
    const ok = await confirmAction({ title: 'Delete saved search?', message: `“${s.name}” (${s.query}) will be removed on every device.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await deleteSavedSearch(s.id);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section className="saved-searches" aria-label="Saved searches">
      <h3 className="saved-searches-title">Saved searches</h3>
      <ul className="saved-search-list">
        {searches.map((s) => (
          <li key={s.id} className="saved-search">
            <button type="button" className="saved-search-main" onClick={() => onPick(s)} title={s.query}>
              <BookmarkCheck size={14} aria-hidden />
              <span className="saved-search-name">{s.name}</span>
              <code className="saved-search-query">{s.query}</code>
            </button>
            <button type="button" className="icon-button saved-search-action" aria-label={`Rename ${s.name}`} title="Rename" onClick={() => void rename(s)}>
              <Pencil size={13} />
            </button>
            <button type="button" className="icon-button saved-search-action" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => void remove(s)}>
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SearchHelp() {
  return (
    <div className="panel-empty search-help">
      <p>
        Search words and “exact phrases”; <code>-word</code> excludes, <code>a OR b</code> and <code>(…)</code> combine.
      </p>
      <p>
        Filters: <code>tag:#work</code> <code>path:Projects</code> <code>file:plan</code>
      </p>
      <p>
        <code>/regex/</code> for a regular expression, <code>line:(a b)</code> and <code>section:(a b)</code> for words on one line or under one heading.
      </p>
      <p>PDF attachments are searched too.</p>
    </div>
  );
}

interface Props {
  query: string;
  onQuery(query: string): void;
  /** Focus the field when shown (phone page, Mod-Shift-F). */
  autoFocus?: boolean;
}

export function SearchView({ query, onQuery, autoFocus }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<SearchSort>('relevance');
  const [exact, setExact] = useState<string | null>(null);
  const debounced = useDebounced(query);
  const trimmed = debounced.trim();
  // "Exact words only" applies to the query it was chosen for.
  const fuzzy = exact !== trimmed;
  const search = useSearch(trimmed, sort, fuzzy);
  const saved = useSavedSearches();
  const focusRequest = useUi((s) => s.searchFocus);
  const { items: bookmarks } = useBookmarks();
  // A search bookmark (item 12) is for the query as typed; a saved search (item 22) for the one searched.
  const typed = query.trim();
  const starred = typed !== '' && findSearchBookmarks(bookmarks, typed).length > 0;

  useLayoutEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  // Mod-Shift-F focuses the field even when the panel was already open.
  useLayoutEffect(() => {
    if (focusRequest > 0) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusRequest]);

  const data = search.data;
  const empty = trimmed === '';
  const savedList = saved.data?.searches ?? [];
  const current = empty ? undefined : findSavedSearch(savedList, trimmed, sort);
  const highlight = data && data.corrections.length > 0 ? `${trimmed} ${data.corrections.flatMap((c) => c.replacements).join(' ')}` : trimmed;

  const save = async () => {
    if (current) {
      const ok = await confirmAction({ title: 'Remove saved search?', message: `“${current.name}” will be removed on every device.`, confirmLabel: 'Remove' });
      if (ok) await deleteSavedSearch(current.id).catch(toastError);
      return;
    }
    const name = await promptText({ title: 'Save search', label: 'Name', value: trimmed, confirmLabel: 'Save', validate: (v) => (v.trim() ? null : 'Enter a name') });
    if (name === null) return;
    try {
      await addSavedSearch(name, trimmed, sort);
      toast(`Saved “${name.trim()}”`);
    } catch (e) {
      toastError(e);
    }
  };

  const pick = (s: SavedSearch) => {
    setSort(s.sort);
    onQuery(s.query);
    input.current?.focus();
  };

  return (
    <div className="search-view">
      <div className="search-field">
        <Search size={15} className="search-field-icon" aria-hidden />
        <input
          ref={input}
          type="search"
          className="text-input search-input"
          placeholder="Search notes…"
          aria-label="Search in all notes"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {query && (
          <button type="button" className="icon-button search-clear" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="search-toolbar">
        <span className="search-count" aria-live="polite">
          {empty ? '' : search.isError ? '' : data ? `${data.total} ${data.total === 1 ? 'result' : 'results'}${data.total > data.results.length ? ` · showing ${data.results.length}` : ''}` : 'Searching…'}
        </span>
        {typed !== '' && (
          <button
            type="button"
            className={`icon-button search-star${starred ? ' is-on' : ''}`}
            aria-pressed={starred}
            aria-label={starred ? 'Remove the bookmark for this search' : 'Bookmark this search'}
            title={starred ? 'Remove bookmark' : 'Bookmark this search'}
            onClick={() => void toggleSearchBookmark(typed)}
          >
            <Star size={14} fill={starred ? 'currentColor' : 'none'} />
          </button>
        )}
        {!empty && (
          <button
            type="button"
            className={`icon-button search-save${current ? ' is-active' : ''}`}
            aria-label={current ? `Saved as ${current.name}` : 'Save search'}
            title={current ? `Saved as “${current.name}”` : 'Save search'}
            aria-pressed={!!current}
            onClick={() => void save()}
          >
            {current ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
          </button>
        )}
        <label className="search-sort" title="Sort results">
          <ArrowDownWideNarrow size={14} aria-hidden />
          <select value={sort} onChange={(e) => setSort(e.target.value as SearchSort)} aria-label="Sort results">
            <option value="relevance">Relevance</option>
            <option value="mtime">Modified</option>
          </select>
        </label>
      </div>
      {!empty && data && !search.isError && <Corrections data={data} onExact={() => setExact(trimmed)} />}
      <div className="search-results">
        {empty ? (
          <>
            {savedList.length > 0 && <SavedSearches searches={savedList} onPick={pick} />}
            <SearchHelp />
          </>
        ) : search.isError ? (
          <div className="panel-empty search-error" role="alert">
            {errorMessage(search.error)}
          </div>
        ) : data && data.results.length === 0 ? (
          <div className="panel-empty">No matches.</div>
        ) : (
          <ul className="search-hits" aria-busy={search.isFetching}>
            {data?.results.map((hit) => <Hit key={hit.path} hit={hit} highlight={highlight} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
