// The graph's server data (API.md §11.4) for the graph views (ROADMAP item 16, DESIGN §6.21).
// The tree query is patched by every SSE event and every own write, so a change of the tree (or of
// the settings, for excluded paths) schedules a refresh. The refresh sends the current version as
// `since`, so an edit that changed no link costs an empty answer and leaves the layout alone.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { api } from '../../api/endpoints';
import { currentTree } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { GraphResponse } from '../../api/types';
import { baseGraph, type BaseGraph } from './model';

export const GRAPH_REFRESH_MS = 800;

export async function fetchGraph(): Promise<GraphResponse> {
  const previous = queryClient.getQueryData<GraphResponse>(queryKeys.graph());
  const next = await api.getGraph(previous?.version);
  return next.unchanged && previous ? previous : next;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let watchers = 0;
let unsubscribe: (() => void) | null = null;

function scheduleRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void queryClient.invalidateQueries({ queryKey: queryKeys.graph() });
  }, GRAPH_REFRESH_MS);
}

/** Watches the tree and settings while at least one graph view is mounted. */
function watch(): () => void {
  if (watchers++ === 0) {
    unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const key = event.query.queryKey[0];
      if (key === 'tree' || key === 'settings') scheduleRefresh();
    });
  }
  return () => {
    if (--watchers === 0) {
      unsubscribe?.();
      unsubscribe = null;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };
}

export function useGraphData(): { base: BaseGraph | null; loading: boolean; error: unknown } {
  const query = useQuery({ queryKey: queryKeys.graph(), queryFn: fetchGraph, staleTime: Infinity, refetchOnWindowFocus: false });
  useEffect(() => watch(), []);
  const data = query.data;
  const base = useMemo(() => {
    if (!data) return null;
    // Aliases (for the search filter) are read from the tree when the graph changes.
    const tree = currentTree();
    return baseGraph(data, (path) => tree.byPath.get(path)?.aliases ?? []);
  }, [data]);
  return { base, loading: query.isPending, error: query.error };
}
