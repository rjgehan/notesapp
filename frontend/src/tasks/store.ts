// The client's task store (DESIGN §6.22): one normalized copy of every task and list this page
// has seen, kept current by query responses, SSE events and this tab's own write results, with
// optimistic changes layered on top as overlays. Views are pure filters over it (model.ts), so a
// change shows up in every view at once, and rolling back an optimistic change is dropping its
// overlay: what is underneath is always the server's state as last known.
//
// Responses race with events: a GET that started before an event arrived may answer with the
// older state. Every authoritative change stamps the task with a generation; a response only
// writes tasks whose stamp is older than the request (and only removes those), so a late
// response never undoes a newer event or write result.
import { useSyncExternalStore } from 'react';
import type { Task, TaskFileProblem, TaskList, TasksResponse } from '../api/types';
import { sortLists } from './model';

/** Field changes for one task, or null: the task is gone (deleted, or moved out of view). */
export type TaskPatch = Partial<Task> | null;

interface Overlay {
  id: number;
  patches: ReadonlyMap<string, TaskPatch>;
  creates: readonly Task[];
}

export class TaskStore {
  private base = new Map<string, Task>();
  private listMap = new Map<string, TaskList>();
  private problemList: TaskFileProblem[] = [];
  private listsKnown = false;
  private overlays: Overlay[] = [];
  private stamps = new Map<string, number>();
  private listStamps = new Map<string, number>();
  private gen = 0;
  private nextOverlay = 1;
  private version = 0;
  private listeners = new Set<() => void>();
  private merged: { version: number; tasks: Map<string, Task> } | null = null;
  private orderedLists: { version: number; lists: TaskList[] } | null = null;

  // ---------- subscription ----------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  /** The generation to pass to `mergeResponse` for a request that starts now. */
  generation(): number {
    return this.gen;
  }

  // ---------- authoritative changes: events and write results ----------

  upsert(tasks: readonly Task[]): void {
    if (tasks.length === 0) return;
    const g = ++this.gen;
    for (const t of tasks) {
      this.base.set(t.id, t);
      this.stamps.set(t.id, g);
    }
    this.changed();
  }

  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const g = ++this.gen;
    for (const id of ids) {
      this.base.delete(id);
      this.stamps.set(id, g);
    }
    this.changed();
  }

  upsertLists(lists: readonly TaskList[]): void {
    if (lists.length === 0) return;
    const g = ++this.gen;
    for (const l of lists) {
      this.listMap.set(l.id, l);
      this.listStamps.set(l.id, g);
    }
    this.changed();
  }

  /** A list is gone (deleted, or its file was trashed): its tasks go with it. */
  removeList(listId: string): void {
    const g = ++this.gen;
    this.listMap.delete(listId);
    this.listStamps.set(listId, g);
    for (const t of [...this.base.values()]) {
      if (t.listId !== listId) continue;
      this.base.delete(t.id);
      this.stamps.set(t.id, g);
    }
    this.changed();
  }

  // ---------- responses ----------

  /** Every usable list and the problems (GET /api/tasks/lists, or any GET /api/tasks). */
  setLists(lists: readonly TaskList[], problems: readonly TaskFileProblem[], since: number): void {
    const next = new Map<string, TaskList>();
    for (const l of lists) next.set(l.id, l);
    // Lists changed by events or writes since the request started keep their newer state.
    for (const [id, stamp] of this.listStamps) {
      if (stamp <= since) continue;
      const current = this.listMap.get(id);
      if (current) next.set(id, current);
      else next.delete(id);
    }
    this.listMap = next;
    this.problemList = [...problems];
    this.listsKnown = true;
    this.changed();
  }

  /**
   * Merges a view's response. `inScope` is the view's rule (model.ts): a task the store holds that
   * the rule selects but the response lacks is gone from the view on the server (a hand edit,
   * another device, a change whose event this page will not get), and is removed.
   */
  mergeResponse(response: TasksResponse, inScope: (task: Task, lists: ReadonlyMap<string, TaskList>) => boolean, since: number): void {
    this.setListsQuietly(response, since);
    const fresh = (id: string) => (this.stamps.get(id) ?? -1) <= since;
    const ids = new Set<string>();
    for (const t of response.tasks) {
      ids.add(t.id);
      if (fresh(t.id)) this.base.set(t.id, t);
    }
    for (const t of [...this.base.values()]) {
      if (!ids.has(t.id) && fresh(t.id) && inScope(t, this.listMap)) this.base.delete(t.id);
    }
    this.changed();
  }

  /** Tasks fetched one by one (GET /api/tasks/{id}): written unless an event or write was newer. */
  mergeTasks(tasks: readonly Task[], since: number): void {
    let changed = false;
    for (const t of tasks) {
      if ((this.stamps.get(t.id) ?? -1) > since) continue;
      this.base.set(t.id, t);
      changed = true;
    }
    if (changed) this.changed();
  }

  private setListsQuietly(response: TasksResponse, since: number): void {
    const listeners = this.listeners;
    this.listeners = new Set();
    try {
      this.setLists(response.lists, response.problems, since);
    } finally {
      this.listeners = listeners;
    }
  }

  // ---------- optimistic overlays ----------

  /** Layers optimistic changes over the known state; returns the id to drop it with. */
  addOverlay(patches: ReadonlyMap<string, TaskPatch>, creates: readonly Task[] = []): number {
    const id = this.nextOverlay++;
    this.overlays.push({ id, patches, creates });
    this.changed();
    return id;
  }

  /** Removes an overlay: after the write's result is applied, or to roll the change back. */
  dropOverlay(id: number): void {
    const before = this.overlays.length;
    this.overlays = this.overlays.filter((o) => o.id !== id);
    if (this.overlays.length !== before) this.changed();
  }

  hasPending(taskId: string): boolean {
    return this.overlays.some((o) => o.patches.has(taskId) || o.creates.some((t) => t.id === taskId));
  }

  // ---------- reads ----------

  /** Every task as this page shows it: the known state with the pending overlays applied. */
  tasks(): ReadonlyMap<string, Task> {
    if (this.merged?.version === this.version) return this.merged.tasks;
    const tasks = new Map(this.base);
    for (const o of this.overlays) {
      for (const t of o.creates) tasks.set(t.id, t);
      for (const [id, patch] of o.patches) {
        if (patch === null) {
          tasks.delete(id);
          continue;
        }
        const current = tasks.get(id);
        if (current) tasks.set(id, { ...current, ...patch });
      }
    }
    this.merged = { version: this.version, tasks };
    return tasks;
  }

  task(id: string): Task | undefined {
    return this.tasks().get(id);
  }

  /** The known server state of a task, without pending changes (the `base` of a change). */
  knownTask(id: string): Task | undefined {
    return this.base.get(id);
  }

  listMapView(): ReadonlyMap<string, TaskList> {
    return this.listMap;
  }

  /** Every usable list, in order. */
  lists(): TaskList[] {
    if (this.orderedLists?.version === this.version) return this.orderedLists.lists;
    const lists = sortLists(this.listMap.values());
    this.orderedLists = { version: this.version, lists };
    return lists;
  }

  list(id: string): TaskList | undefined {
    return this.listMap.get(id);
  }

  problems(): readonly TaskFileProblem[] {
    return this.problemList;
  }

  /** True once a response has listed the lists. */
  hasLists(): boolean {
    return this.listsKnown;
  }

  /** Forgets everything (tests). */
  reset(): void {
    this.base.clear();
    this.listMap.clear();
    this.problemList = [];
    this.listsKnown = false;
    this.overlays = [];
    this.stamps.clear();
    this.listStamps.clear();
    this.gen = 0;
    this.changed();
  }
}

export const taskStore = new TaskStore();

/** Re-renders when the store changes; returns its version, for memoizing derived views. */
export function useTaskStore(store: TaskStore = taskStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}
