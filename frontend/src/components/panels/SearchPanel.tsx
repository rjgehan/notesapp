import { useUi } from '../../state/ui';
import { SearchView } from '../search/SearchView';

/** The Search tab of the left sidebar: its query lives in zustand, never in the route. */
export default function SearchPanel() {
  const query = useUi((s) => s.searchQuery);
  const setQuery = useUi((s) => s.setSearchQuery);
  return <SearchView query={query} onQuery={setQuery} />;
}
