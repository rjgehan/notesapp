// The page's bookmarks (DESIGN §6.23): the server's list (TanStack Query, refreshed on
// `bookmarks.changed`) with this tab's unsaved edits laid over it, and the actions the panel,
// menus and commands use. Every change is saved through one BookmarkWriter.
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys, STALE } from '../api/queryKeys';
import type { BookmarkItem, BookmarksResponse } from '../api/types';
import { promptText } from '../state/dialogs';
import { toast } from '../state/toasts';
import {
  BookmarkWriter,
  type BookmarkEdit,
  type ItemPath,
  fileBookmark,
  findFileBookmarks,
  findFolderBookmarks,
  findSearchBookmarks,
  folderBookmark,
  groupBookmark,
  insertAt,
  removeAll,
  searchBookmark,
} from './bookmarks';
import { toastError } from './errors';
import { displayName } from './paths';

export const bookmarksQuery = {
  queryKey: queryKeys.bookmarks(),
  queryFn: () => api.getBookmarks(),
  staleTime: STALE.bookmarks,
};

export const bookmarkWriter = new BookmarkWriter({
  cached: () => queryClient.getQueryData<BookmarksResponse>(queryKeys.bookmarks()),
  fetch: () => queryClient.fetchQuery({ ...bookmarksQuery, staleTime: 0 }),
  put: (req) => api.putBookmarks(req),
  store: (saved) => queryClient.setQueryData(queryKeys.bookmarks(), saved),
  onError: (e) => toastError(e, 'Bookmarks'),
});

/** The bookmarks to show, with this tab's unsaved edits; re-renders on both. */
export function useBookmarks(): { items: BookmarkItem[]; isPending: boolean; isError: boolean } {
  // The page's client, provider or not: the writer caches into it too.
  const query = useQuery(bookmarksQuery, queryClient);
  useSyncExternalStore(bookmarkWriter.subscribe, bookmarkWriter.getVersion);
  return { items: bookmarkWriter.view(query.data?.items), isPending: query.isPending, isError: query.isError };
}

/** The bookmarks for non-React code (commands' `when`); empty before the first load. */
export function currentBookmarks(): BookmarkItem[] {
  return bookmarkWriter.view(queryClient.getQueryData<BookmarksResponse>(queryKeys.bookmarks())?.items);
}

/** Loads the bookmarks in the background, so commands can tell what is bookmarked. */
export function prefetchBookmarks(): void {
  void queryClient.prefetchQuery(bookmarksQuery).catch(() => undefined);
}

export function editBookmarks(edit: BookmarkEdit): Promise<void> {
  return bookmarkWriter.edit(edit);
}

export function isFileBookmarked(items: readonly BookmarkItem[], path: string, subpath: string | null = null): boolean {
  return findFileBookmarks(items, path, subpath).length > 0;
}

/** Bookmarks a file (or one of its headings), or removes that bookmark when it exists. */
export function toggleFileBookmark(path: string, subpath: string | null = null): Promise<void> {
  const had = isFileBookmarked(currentBookmarks(), path, subpath);
  const name = subpath ? subpath.replace(/^#/, '') : displayName(path);
  toast(had ? `Removed the bookmark for “${name}”` : `Bookmarked “${name}”`);
  return editBookmarks((items) => {
    const found = findFileBookmarks(items, path, subpath);
    if (had) return removeAll(items, found);
    return found.length > 0 ? items : insertAt(items, [], fileBookmark(path, subpath));
  });
}

export function toggleFolderBookmark(path: string): Promise<void> {
  const had = findFolderBookmarks(currentBookmarks(), path).length > 0;
  toast(had ? `Removed the bookmark for “${displayName(path)}”` : `Bookmarked “${displayName(path)}”`);
  return editBookmarks((items) => {
    const found = findFolderBookmarks(items, path);
    if (had) return removeAll(items, found);
    return found.length > 0 ? items : insertAt(items, [], folderBookmark(path));
  });
}

export function toggleSearchBookmark(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return Promise.resolve();
  const had = findSearchBookmarks(currentBookmarks(), q).length > 0;
  toast(had ? 'Removed the bookmark for this search' : 'Bookmarked this search');
  return editBookmarks((items) => {
    const found = findSearchBookmarks(items, q);
    if (had) return removeAll(items, found);
    return found.length > 0 ? items : insertAt(items, [], searchBookmark(q));
  });
}

export function addGroup(title: string, parent: ItemPath = []): Promise<void> {
  return editBookmarks((items) => insertAt(items, parent, groupBookmark(title)));
}

/** Asks for a name and adds an empty group (at the end of `parent`, the top level by default). */
export async function promptNewGroup(parent: ItemPath = []): Promise<void> {
  const title = await promptText({ title: 'New bookmark group', label: 'Name', value: '', placeholder: 'Group name', confirmLabel: 'Create' });
  if (title && title.trim()) await addGroup(title.trim(), parent);
}
