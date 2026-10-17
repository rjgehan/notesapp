// TanStack Query hooks (DESIGN §6.3) plus synchronous accessors for non-React code.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DEFAULT_SETTINGS } from '../features/settings';
import { treePatchCount } from '../sync/treePatch';
import { api } from './endpoints';
import { queryClient } from './queryClient';
import { queryKeys, STALE } from './queryKeys';
import type { NoteMeta, Settings, SettingsResponse, TagsResponse, TreeResponse } from './types';
import { buildVaultTree, EMPTY_TREE, type VaultTree } from './vaultTree';

export const treeQuery = {
  queryKey: queryKeys.tree(),
  queryFn: () => api.getTree(),
  staleTime: STALE.tree,
};

export function useTree() {
  return useQuery({ ...treeQuery, select: buildVaultTree });
}

/**
 * Fetches the tree now (startup, resync) and returns the snapshot. Own mutations patch the tree
 * while the request runs (SSE events are buffered meanwhile, API.md §16.5), and the snapshot may
 * predate them: when a patch landed during the fetch, the tree is fetched again, so the newer
 * snapshot (which includes the mutation) is the one installed.
 */
export async function refetchTree(): Promise<TreeResponse> {
  let tree: TreeResponse;
  let attempts = 0;
  for (;;) {
    const before = treePatchCount();
    tree = await queryClient.fetchQuery({ ...treeQuery, staleTime: 0 });
    if (treePatchCount() === before || ++attempts >= 3) return tree;
  }
}

/** The tree for non-React code; an empty tree before the first load. */
export function currentTree(): VaultTree {
  return buildVaultTree(queryClient.getQueryData<TreeResponse>(queryKeys.tree()) ?? EMPTY_TREE);
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => api.getSettings(),
    staleTime: STALE.settings,
  });
}

/** Vault settings, falling back to the defaults while loading. */
export function useVaultSettings(): Settings {
  return useSettings().data?.settings ?? DEFAULT_SETTINGS;
}

export function currentSettings(): Settings {
  return queryClient.getQueryData<SettingsResponse>(queryKeys.settings())?.settings ?? DEFAULT_SETTINGS;
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me(), queryFn: () => api.getMe(), staleTime: STALE.me });
}

export function useStatus() {
  return useQuery({ queryKey: queryKeys.status(), queryFn: () => api.getStatus(), staleTime: STALE.status });
}

export function useNoteMeta(path: string | null) {
  return useQuery({
    queryKey: queryKeys.meta(path ?? ''),
    queryFn: () => api.getNoteMeta(path!),
    staleTime: STALE.meta,
    enabled: path !== null,
  });
}

export function fetchNoteMeta(path: string): Promise<NoteMeta> {
  return queryClient.fetchQuery({ queryKey: queryKeys.meta(path), queryFn: () => api.getNoteMeta(path), staleTime: STALE.meta });
}

export function useBacklinks(path: string | null, unlinked: boolean, enabled = true) {
  return useQuery({
    queryKey: queryKeys.backlinks(path ?? '', unlinked),
    queryFn: () => api.getBacklinks(path!, unlinked),
    staleTime: STALE.backlinks,
    enabled: enabled && path !== null,
  });
}

export function useSearch(q: string, sort: 'relevance' | 'mtime' = 'relevance') {
  return useQuery({
    queryKey: queryKeys.search(q, sort),
    queryFn: () => api.search(q, { sort, prefix: true }),
    staleTime: STALE.search,
    enabled: q.trim() !== '',
    placeholderData: (prev) => prev,
  });
}

export function useTags() {
  return useQuery({ queryKey: queryKeys.tags(), queryFn: () => api.getTags(), staleTime: STALE.tags });
}

export function fetchTags(): Promise<TagsResponse> {
  return queryClient.fetchQuery({ queryKey: queryKeys.tags(), queryFn: () => api.getTags(), staleTime: STALE.tags });
}

const HISTORY_PAGE = 50;

/** History of a path, paged with "Load more" (offset paging, API.md §14.1). */
export function useHistory(path: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.history(path ?? ''),
    queryFn: ({ pageParam }) => api.getHistory(path!, { limit: HISTORY_PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.entries.length, 0) : undefined),
    staleTime: STALE.history,
    enabled: path !== null,
  });
}

export function useHistoryContent(commit: string | null, path: string | null) {
  return useQuery({
    queryKey: queryKeys.historyContent(commit ?? '', path ?? ''),
    queryFn: () => api.getHistoryContent(path!, commit!),
    staleTime: STALE.historyContent,
    enabled: commit !== null && path !== null,
  });
}

export function useTrash() {
  return useQuery({ queryKey: queryKeys.trash(), queryFn: () => api.listTrash(), staleTime: STALE.trash });
}

export function useTemplates() {
  return useQuery({ queryKey: queryKeys.templates(), queryFn: () => api.getTemplates(), staleTime: STALE.templates });
}

/** Read-only text content (embeds, previews). Editing goes through DocumentSession. */
export function useTextFile(path: string | null) {
  return useQuery({
    queryKey: queryKeys.file(path ?? ''),
    queryFn: () => api.readFile(path!),
    staleTime: STALE.file,
    enabled: path !== null,
  });
}

/** `useTextFile` outside React, from the same cache (a note embedded in a drawing). */
export function fetchTextFile(path: string) {
  return queryClient.fetchQuery({ queryKey: queryKeys.file(path), queryFn: () => api.readFile(path), staleTime: STALE.file });
}
