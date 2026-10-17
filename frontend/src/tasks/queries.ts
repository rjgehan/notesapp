// Loading task views (API.md §20.2) into the store. A query's data is only the response's
// metadata; the tasks live in the store, where events and writes keep them current, so the
// queries never go stale on their own (staleTime Infinity). They refetch when invalidated: on a
// resync (every query but the tree), after a change to a `.tasks` file that came without task
// events (sync.ts), and after a write fails.
import { useQueries, useQuery } from '@tanstack/react-query';
import { queryClient } from '../api/queryClient';
import type { LocalDate, Task, TaskFileProblem, TaskList } from '../api/types';
import { taskApi, type TaskQueryParams } from './api';
import { inList, inOpenLists, inToday } from './model';
import { taskStore } from './store';

export interface ViewMeta {
  total: number;
  problems: TaskFileProblem[];
}

export const taskKeys = {
  all: () => ['tasks'] as const,
  lists: () => ['tasks', 'lists'] as const,
  view: (params: TaskQueryParams) => ['tasks', 'view', params] as const,
};

type Scope = (task: Task, lists: ReadonlyMap<string, TaskList>) => boolean;

/** The rule a view's response covers, so tasks it no longer holds can be dropped. */
export function scopeOf(params: TaskQueryParams): Scope {
  switch (params.view) {
    case 'today':
      return (t, lists) => inToday(t, params.date ?? '', lists);
    case 'list':
      if (params.list !== undefined) {
        const listId = params.list;
        return params.status === 'all' ? (t) => inList(t, listId) : (t) => inList(t, listId) && t.status === 'open';
      }
      return params.status === undefined ? (t, lists) => inOpenLists(t, lists) : () => false;
    default:
      // Views this step does not mirror (upcoming, completed, search) only add tasks.
      return () => false;
  }
}

export async function loadView(params: TaskQueryParams): Promise<ViewMeta> {
  const since = taskStore.generation();
  const response = await taskApi.query(params);
  taskStore.mergeResponse(response, scopeOf(params), since);
  return { total: response.total, problems: response.problems };
}

export async function loadLists(): Promise<ViewMeta> {
  const since = taskStore.generation();
  const response = await taskApi.lists();
  taskStore.setLists(response.lists, response.problems, since);
  return { total: response.lists.length, problems: response.problems };
}

const viewQuery = (params: TaskQueryParams) => ({
  queryKey: taskKeys.view(params),
  queryFn: () => loadView(params),
  staleTime: Infinity,
});

export const todayParams = (date: LocalDate): TaskQueryParams => ({ view: 'today', date });
export const listParams = (listId: string): TaskQueryParams => ({ view: 'list', list: listId, status: 'all' });
export const OPEN_TASKS: TaskQueryParams = { view: 'list' };

export function useTaskView(params: TaskQueryParams, enabled = true) {
  return useQuery({ ...viewQuery(params), enabled });
}

/** Several views at once (the note panel loads each list that links to the note). */
export function useTaskViews(all: readonly TaskQueryParams[]) {
  return useQueries({ queries: all.map(viewQuery) });
}

export function useTaskLists() {
  return useQuery({ queryKey: taskKeys.lists(), queryFn: loadLists, staleTime: Infinity });
}

/** Makes sure the lists are known (quick add resolves `@List` against them). */
export function ensureLists(): Promise<unknown> {
  return queryClient.fetchQuery({ queryKey: taskKeys.lists(), queryFn: loadLists, staleTime: Infinity });
}

/** Refetches every task view that is shown (and marks the others stale). */
export function invalidateTaskViews(): void {
  void queryClient.invalidateQueries({ queryKey: taskKeys.all() });
}
