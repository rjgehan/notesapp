// Saved searches (API.md §12.3): the list lives in the vault (`.notesapp/searches.json`) and is
// replaced as a whole with a version token. Every change is an operation on the latest list, so
// when another device saved meanwhile (409 version-conflict) the list is fetched again and the
// operation re-applied.
import { isVersionConflict } from '../api/client';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { SavedSearch, SavedSearchesResponse, SearchSort } from '../api/types';

const ATTEMPTS = 3;

/** Applies `change` to the latest list and saves it; retries on a version conflict. */
export async function updateSavedSearches(change: (list: SavedSearch[]) => SavedSearch[]): Promise<SavedSearchesResponse> {
  let current = queryClient.getQueryData<SavedSearchesResponse>(queryKeys.savedSearches()) ?? (await api.getSavedSearches());
  for (let attempt = 1; ; attempt++) {
    try {
      const saved = await api.putSavedSearches({ searches: change(current.searches), baseVersion: current.version });
      queryClient.setQueryData(queryKeys.savedSearches(), saved);
      return saved;
    } catch (e) {
      if (!isVersionConflict(e) || attempt >= ATTEMPTS) throw e;
      current = await api.getSavedSearches();
      queryClient.setQueryData(queryKeys.savedSearches(), current);
    }
  }
}

export function newSavedSearchId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return 's-' + random.replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
}

export function addSavedSearch(name: string, query: string, sort: SearchSort): Promise<SavedSearchesResponse> {
  const search: SavedSearch = { id: newSavedSearchId(), name: name.trim(), query: query.trim(), sort };
  return updateSavedSearches((list) => [...list, search]);
}

export function renameSavedSearch(id: string, name: string): Promise<SavedSearchesResponse> {
  return updateSavedSearches((list) => list.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)));
}

export function deleteSavedSearch(id: string): Promise<SavedSearchesResponse> {
  return updateSavedSearches((list) => list.filter((s) => s.id !== id));
}

/** The saved search with exactly this query and sort, if any. */
export function findSavedSearch(list: readonly SavedSearch[] | undefined, query: string, sort: SearchSort): SavedSearch | undefined {
  const q = query.trim();
  return list?.find((s) => s.query.trim() === q && s.sort === sort);
}
