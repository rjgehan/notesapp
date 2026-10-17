// Full-text search (DESIGN §6.4, API.md §12.1), shared by the desktop panel (query in zustand,
// never in the route) and the phone search page (`/search?q=`). Input is debounced by 200 ms.
import { ArrowDownWideNarrow, FileText, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useSearch } from '../../api/hooks';
import type { SearchHit } from '../../api/types';
import { afterOpen, isKeyboardClick } from '../../features/focus';
import { navigateTo } from '../../features/navigation';
import { folderOf, noteRoute } from '../../features/paths';
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

function hitRoute(hit: SearchHit, line: number | null, query: string): string {
  if (line === null) return noteRoute(hit.path);
  return noteRoute(hit.path) + `?line=${line}&q=${encodeURIComponent(query)}`;
}

function Hit({ hit, query }: { hit: SearchHit; query: string }) {
  const open = (line: number | null, e: { detail: number }) => {
    useUi.getState().setDrawerOpen(false);
    afterOpen(hit.path, isKeyboardClick(e));
    navigateTo(hitRoute(hit, line, query));
  };
  const folder = folderOf(hit.path);
  return (
    <li className="search-hit">
      <button type="button" className="search-hit-title" onClick={(e) => open(hit.matches[0]?.line ?? null, e)} title={hit.path}>
        <FileText size={14} aria-hidden />
        <span className="search-hit-name">
          <HighlightedText text={hit.basename} ranges={hit.titleRanges} />
        </span>
        {folder && <span className="search-hit-folder">{folder}</span>}
      </button>
      {hit.matches.length > 0 && (
        <ul className="search-matches">
          {hit.matches.map((m) => (
            <li key={m.line}>
              <button type="button" className="search-match" onClick={(e) => open(m.line, e)}>
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

interface Props {
  query: string;
  onQuery(query: string): void;
  /** Focus the field when shown (phone page, Mod-Shift-F). */
  autoFocus?: boolean;
}

export function SearchView({ query, onQuery, autoFocus }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<'relevance' | 'mtime'>('relevance');
  const debounced = useDebounced(query);
  const search = useSearch(debounced.trim(), sort);
  const focusRequest = useUi((s) => s.searchFocus);

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
  const empty = debounced.trim() === '';
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
        <label className="search-sort" title="Sort results">
          <ArrowDownWideNarrow size={14} aria-hidden />
          <select value={sort} onChange={(e) => setSort(e.target.value as 'relevance' | 'mtime')} aria-label="Sort results">
            <option value="relevance">Relevance</option>
            <option value="mtime">Modified</option>
          </select>
        </label>
      </div>
      <div className="search-results">
        {empty ? (
          <div className="panel-empty search-help">
            <p>Search words and “exact phrases”.</p>
            <p>
              Filters: <code>tag:#work</code> <code>path:Projects</code> <code>file:plan</code>, and <code>-word</code> to exclude.
            </p>
          </div>
        ) : search.isError ? (
          <div className="panel-empty">{errorMessage(search.error)}</div>
        ) : data && data.results.length === 0 ? (
          <div className="panel-empty">No matches.</div>
        ) : (
          <ul className="search-hits" aria-busy={search.isFetching}>
            {data?.results.map((hit) => <Hit key={hit.path} hit={hit} query={debounced.trim()} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
