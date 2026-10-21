// Live task updates (API.md §20.8, DESIGN §6.22). Task events from other devices go straight
// into the store through registerEventHandler. Changes to `.tasks` files that come without task
// events (a hand edit, a save of the file as text, a restore, a move, the archive rollover) are
// noticed in the tree, which SSE events and this tab's own writes both keep current: when the
// version of any `.tasks` file differs from what the task views last saw, they refetch
// (debounced). This tab's own task writes acknowledge their files first, so they cause no refetch.
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, ListChangedEvent, TaskDeletedEvent, TaskEvent, TreeResponse } from '../api/types';
import { TASK_EVENT_NAMES } from '../api/types';
import { invalidateTaskViews } from './queries';
import type { TaskStore } from './store';

export const REFETCH_DEBOUNCE_MS = 1000;

const isTaskFile = (path: string) => path.toLowerCase().endsWith('.tasks');

/** The `.tasks` files of a tree snapshot: path → version. */
export function taskFileVersions(tree: TreeResponse): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const f of tree.files) if (isTaskFile(f.path)) out.set(f.path, f.version);
  return out;
}

function sameVersions(a: ReadonlyMap<string, string | null>, b: ReadonlyMap<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, version] of a) if (!b.has(path) || b.get(path) !== version) return false;
  return true;
}

let known: Map<string, string | null> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let refetch: () => void = invalidateTaskViews;

/** Schedules one refetch of the task views, about a second after the last outside change. */
export function scheduleTaskRefetch(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    refetch();
  }, REFETCH_DEBOUNCE_MS);
}

/** Compares the tree's `.tasks` files with what the views last saw. */
export function checkTaskFiles(tree: TreeResponse | undefined): void {
  if (!tree) return;
  const now = taskFileVersions(tree);
  if (known === null) {
    // The first tree: the views load from scratch anyway.
    known = now;
    return;
  }
  if (sameVersions(known, now)) return;
  known = now;
  scheduleTaskRefetch();
}

/** This tab's own task writes: their list files are already reflected in the store. */
export function acknowledgeFiles(files: readonly FileEntry[]): void {
  if (known === null) return;
  for (const f of files) if (isTaskFile(f.path)) known.set(f.path, f.version);
}

/** Applies a task event to the store. */
export function applyTaskEvent(store: TaskStore, name: string, data: unknown): void {
  switch (name) {
    case 'task.created':
    case 'task.changed':
      store.upsert([(data as TaskEvent).task]);
      return;
    case 'task.deleted':
      store.remove([(data as TaskDeletedEvent).id]);
      return;
    case 'list.changed': {
      const { listId, list, origin } = data as ListChangedEvent;
      if (list) store.upsertLists([list]);
      else store.removeList(listId);
      // The archive rollover moves tasks without task events.
      if (origin === null) scheduleTaskRefetch();
      return;
    }
    default:
      return;
  }
}

/**
 * Wires the store to the event stream and the tree. `register` is registerEventHandler (DESIGN
 * §6.8); returns a function that undoes the tree subscription (tests).
 */
export function installTaskSync(store: TaskStore, qc: QueryClient, register: (name: string, fn: (data: unknown) => void) => void, onRefetch: () => void = invalidateTaskViews): () => void {
  refetch = onRefetch;
  for (const name of TASK_EVENT_NAMES) register(name, (data) => applyTaskEvent(store, name, data));
  checkTaskFiles(qc.getQueryData<TreeResponse>(queryKeys.tree()));
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryKey[0] !== 'tree') return;
    checkTaskFiles(event.query.state.data as TreeResponse | undefined);
  });
}

/** Forgets the known versions and any pending refetch (tests). */
export function resetTaskSync(): void {
  known = null;
  if (timer) clearTimeout(timer);
  timer = null;
  refetch = invalidateTaskViews;
}
