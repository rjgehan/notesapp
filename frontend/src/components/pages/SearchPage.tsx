// `/search?q=` (DESIGN §6.4): the phone search page. Typing replaces the URL, so the back gesture
// returns to the note in one step. Wider screens use the search panel instead.
import { useSearchParams } from 'react-router';
import { SearchView } from '../search/SearchView';
import { usePageTitle } from './usePageTitle';

export function SearchPage() {
  usePageTitle('Search');
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  return (
    <div className="page search-page">
      <h1 className="page-title">Search</h1>
      <SearchView query={query} onQuery={(q) => setParams(q ? { q } : {}, { replace: true })} autoFocus={query === ''} />
    </div>
  );
}
