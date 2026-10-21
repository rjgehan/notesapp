import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { SavedSearch, SavedSearchesResponse, SavedSearchesUpdateRequest } from '../api/types';
import { addSavedSearch, deleteSavedSearch, findSavedSearch, renameSavedSearch } from './savedSearches';

/** A server holding the list, where another device can save in between. */
function server(initial: SavedSearch[]) {
  let state: SavedSearchesResponse = { searches: initial, version: initial.length ? 'v1' : null };
  let n = 1;
  const put = vi.fn(async (req: SavedSearchesUpdateRequest) => {
    if (req.baseVersion !== state.version) {
      throw new ApiError({ type: 'urn:notesapp:problem:version-conflict', title: 'Version conflict', status: 409, code: 'version-conflict', path: '.notesapp/searches.json' });
    }
    state = { searches: structuredClone(req.searches), version: `v${++n}` };
    return structuredClone(state);
  });
  return {
    put,
    get: vi.fn(async () => structuredClone(state)),
    otherDevice(searches: SavedSearch[]) {
      state = { searches, version: `v${++n}` };
    },
  };
}

const open: SavedSearch = { id: 's-open', name: 'Open loops', query: 'tag:#todo', sort: 'relevance' };

let fake: ReturnType<typeof server>;

beforeEach(() => {
  fake = server([open]);
  vi.spyOn(api, 'getSavedSearches').mockImplementation(fake.get);
  vi.spyOn(api, 'putSavedSearches').mockImplementation(fake.put);
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('saved searches', () => {
  it('adds, renames and deletes, keeping the cache current', async () => {
    const added = await addSavedSearch(' Recent ', ' path:Daily ', 'mtime');
    expect(added.searches.map((s) => [s.name, s.query, s.sort])).toEqual([
      ['Open loops', 'tag:#todo', 'relevance'],
      ['Recent', 'path:Daily', 'mtime'],
    ]);
    expect(added.searches[1].id).toMatch(/^s-[A-Za-z0-9-]+$/);
    expect(queryClient.getQueryData<SavedSearchesResponse>(queryKeys.savedSearches())).toEqual(added);
    const renamed = await renameSavedSearch('s-open', 'Todo');
    expect(renamed.searches[0].name).toBe('Todo');
    const deleted = await deleteSavedSearch('s-open');
    expect(deleted.searches.map((s) => s.name)).toEqual(['Recent']);
  });

  it('re-applies a change on top of what another device saved', async () => {
    queryClient.setQueryData(queryKeys.savedSearches(), await fake.get());
    fake.otherDevice([open, { id: 's-other', name: 'Other', query: 'x', sort: 'relevance' }]);
    const saved = await addSavedSearch('Mine', 'y', 'relevance');
    expect(saved.searches.map((s) => s.name)).toEqual(['Open loops', 'Other', 'Mine']);
    expect(fake.put).toHaveBeenCalledTimes(2);
  });

  it('finds the saved search of a query and sort', () => {
    expect(findSavedSearch([open], ' tag:#todo ', 'relevance')).toBe(open);
    expect(findSavedSearch([open], 'tag:#todo', 'mtime')).toBeUndefined();
    expect(findSavedSearch(undefined, 'x', 'relevance')).toBeUndefined();
  });
});
