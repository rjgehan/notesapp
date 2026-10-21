// Loading task views (API.md §20.2) into the store. A query's data is only the response's
// metadata; the tasks live in the store, where events and writes keep them current, so the
// queries never go stale on their own (staleTime Infinity). They refetch when invalidated: on a
// resync (every query but the tree), after a change to a `.tasks` file that came without task
// events (sync.ts), and after a write fails.
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { queryClient } from '../api/queryClient';
import type { LocalDate, Task, TaskFileProblem, TaskList, TasksResponse } from '../api/types';
import { taskApi, type TaskQueryParams } from './api';
import { inListView, inToday, inUpcoming, matchesFilter, statusesOf } from './model';
import { taskStore, type TaskStore } from './store';

export interface ViewMeta {
  total: number;
  problems: TaskFileProblem[];
}

/** A page of the completed log: the metadata, and where the next page starts. */
export interface CompletedPage extends ViewMeta {
  count: number;
  /** The `before` of the next page, or null when this page reached the end. */
  next: string | null;
  /** Tasks completed at or after this instant are all loaded (null: the page reached the end). */
  floor: string | null;
}

export const taskKeys = {
  all: () => ['tasks'] as const,
  lists: () => ['tasks', 'lists'] as const,
  view: (params: TaskQueryParams) => ['tasks', 'view', params] as const,
  completed: (params: Omit<TaskQueryParams, 'view' | 'before'>) => ['tasks', 'completed', params] as const,
};

type Scope = (task: Task, lists: ReadonlyMap<string, TaskList>) => boolean;

const time = (instant: string | null) => (instant ? Date.parse(instant) : NaN);

/**
 * The rule a view's response covers (the server's rules, model.ts), so tasks the store holds that
 * the rule selects but the response lacks can be dropped: they are gone from the view on the
 * server. A search, or a truncated page, covers only what it returned.
 */
export function scopeOf(params: TaskQueryParams, response?: TasksResponse): Scope {
  const statuses = statusesOf(params.status, params.view);
  const filtered = (t: Task) => statuses.has(t.status) && matchesFilter(t, params);
  switch (params.view) {
    case 'today':
      return (t, lists) => filtered(t) && inToday(t, params.date ?? '', lists);
    case 'upcoming':
      return (t, lists) => filtered(t) && inUpcoming(t, params.date ?? '', params.days ?? 14, lists);
    case 'list':
      return (t, lists) => filtered(t) && inListView(t, lists, params.list);
    case 'completed': {
      if (!response) return () => false;
      // A page holds the newest closed tasks before `before`; when it is not the last, only those
      // completed after its last task (others completed at that same instant may be cut off).
      const before = params.before !== undefined ? time(params.before) : Infinity;
      const truncated = response.tasks.length < response.total;
      const floor = truncated ? time(response.tasks.at(-1)?.completedAt ?? null) : -Infinity;
      return (t) => {
        if (!filtered(t)) return false;
        const at = time(t.completedAt);
        if (Number.isNaN(at)) return !truncated && params.before === undefined;
        return at < before && (truncated ? at > floor : true);
      };
    }
    default:
      return () => false;
  }
}

export async function loadView(params: TaskQueryParams): Promise<ViewMeta> {
  const since = taskStore.generation();
  const response = await taskApi.query(params);
  taskStore.mergeResponse(response, scopeOf(params, response), since);
  return { total: response.total, problems: response.problems };
}

export async function loadLists(store: TaskStore = taskStore): Promise<ViewMeta> {
  const since = store.generation();
  const response = await taskApi.lists();
  store.setLists(response.lists, response.problems, since);
  return { total: response.lists.length, problems: response.problems };
}

const viewQuery = (params: TaskQueryParams) => ({
  queryKey: taskKeys.view(params),
  queryFn: () => loadView(params),
  staleTime: Infinity,
});

export const todayParams = (date: LocalDate): TaskQueryParams => ({ view: 'today', date });
export const UPCOMING_DAYS = 14;
export const upcomingParams = (date: LocalDate, days = UPCOMING_DAYS): TaskQueryParams => ({ view: 'upcoming', date, days });
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
  return useQuery({ queryKey: taskKeys.lists(), queryFn: () => loadLists(), staleTime: Infinity });
}

export const COMPLETED_PAGE = 50;

/** Loads one page of `view=completed`; the next page starts just after its last completion time. */
export async function loadCompletedPage(filter: Omit<TaskQueryParams, 'view' | 'before'>, before: string | undefined): Promise<CompletedPage> {
  const params: TaskQueryParams = { ...filter, view: 'completed', limit: COMPLETED_PAGE, ...(before !== undefined ? { before } : {}) };
  const since = taskStore.generation();
  const response = await taskApi.query(params);
  taskStore.mergeResponse(response, scopeOf(params, response), since);
  const last = response.tasks.at(-1)?.completedAt ?? null;
  const truncated = response.tasks.length < response.total;
  // Subtasks completed with their parent share its completion time, so the next page starts a
  // millisecond after the last one (tasks seen twice merge); a page that cannot move on ends.
  const next = truncated && last !== null ? new Date(time(last) + 1).toISOString() : null;
  const stuck = next !== null && before !== undefined && time(next) >= time(before);
  return { total: response.total, problems: response.problems, count: response.tasks.length, next: stuck ? null : next, floor: truncated ? last : null };
}

/** The completed log, page by page (newest first). */
export function useCompletedTasks(filter: Omit<TaskQueryParams, 'view' | 'before'>) {
  return useInfiniteQuery({
    queryKey: taskKeys.completed(filter),
    queryFn: ({ pageParam }) => loadCompletedPage(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    staleTime: Infinity,
  });
}

/** Makes sure the lists are known (quick add resolves `@List` against them). */
export function ensureLists(): Promise<unknown> {
  return queryClient.fetchQuery({ queryKey: taskKeys.lists(), queryFn: () => loadLists(), staleTime: Infinity });
}

/** Refetches every task view that is shown (and marks the others stale). */
export function invalidateTaskViews(): void {
  void queryClient.invalidateQueries({ queryKey: taskKeys.all() });
}
