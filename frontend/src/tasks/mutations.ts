// Task writes (API.md §20.4, §20.5) with optimistic updates (DESIGN §6.22). Each write layers its
// expected outcome over the store at once, sends the request, then applies the server's result
// and drops the layer; on failure dropping the layer is the rollback. Writes to the same task
// are sent one after another, so the `base` of a second edit is what the first one wrote, and
// every write keeps one Idempotency-Key across its retries.
import { isProblem, isTransient } from '../api/client';
import { refetchTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import type {
  CreateTaskRequest,
  FileEntry,
  Task,
  TaskConflictProblem,
  TaskFields,
  TaskList,
  TaskListFields,
  TaskListWriteResult,
  TaskStatus,
  TaskWriteResult,
} from '../api/types';
import { toastError } from '../features/errors';
import { activePath, navigateTo, openPath } from '../features/navigation';
import { displayName } from '../features/paths';
import { newIdempotencyKey } from '../state/clientId';
import { confirmAction } from '../state/dialogs';
import { toast, useToasts } from '../state/toasts';
import { useUi } from '../state/ui';
import { applyMoveResult, applyTrashEntry } from '../sync/applyEvents';
import { documents } from '../sync/instance';
import { syncTarget } from '../sync/liveSync';
import { addFolders, invalidateContentQueries, refreshFileQuery, upsertFiles } from '../sync/treePatch';
import { taskApi } from './api';
import { formatTaskDate, localToday } from './dates';
import { compareKeys, isValidKey, keyBetween } from './fractionalIndex';
import { loadRecurrence } from './loadRecurrence';
import { childrenByParent, compareOrder, descendants } from './model';
import { invalidateTaskViews, loadLists } from './queries';
import { taskStore, type TaskPatch, type TaskStore } from './store';
import { acknowledgeFiles } from './sync';
import { appPathname } from '../state/vault';

// ---------- applying results ----------

/** List files a write changed: the tree, open sessions and content queries, as for file.changed. */
function applyFiles(files: readonly FileEntry[], createdFolders: readonly string[]): void {
  // The tree watcher must not take this tab's own writes for outside changes (sync.ts).
  acknowledgeFiles(files);
  addFolders(queryClient, [...createdFolders]);
  upsertFiles(queryClient, [...files]);
  for (const f of files) {
    refreshFileQuery(queryClient, f.path);
    // The list file may be open as text; it adopts the new content (or shows the conflict banner).
    void documents.get(f.path)?.onRemoteChanged(f);
    invalidateContentQueries(queryClient, f.path);
  }
}

export function applyTaskWriteResult(result: TaskWriteResult, store: TaskStore = taskStore): void {
  applyFiles(result.files, result.createdFolders);
  // A list the write created (the Inbox, on first use): its list.changed is not echoed to this tab.
  store.upsertLists(result.lists);
  const tasks = result.task ? [result.task, ...result.changed] : result.changed;
  store.upsert(tasks);
  store.remove(result.deleted);
  // Every view needs a task's list; one this page does not know yet is fetched.
  if (tasks.some((t) => !t.archived && store.list(t.listId) === undefined)) void loadLists(store).catch(() => undefined);
}

export function applyTaskListWriteResult(result: TaskListWriteResult, store: TaskStore = taskStore): void {
  if (result.moved) {
    const { from, to } = result.moved;
    applyMoveResult(syncTarget, { dryRun: false, type: 'file', from, to, moved: [result.moved], createdFolders: [], linkUpdates: [], failed: [], commitId: null });
  }
  applyFiles(result.files, result.createdFolders);
  if (result.trash) applyTrashEntry(syncTarget, result.trash);
  store.upsertLists(result.lists);
}

// ---------- running a write ----------

const queues = new Map<string, Promise<unknown>>();

/** Runs `fn` after the earlier writes to the same tasks have settled. */
function serialize<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const prior = keys.map((k) => queues.get(k)).filter((p): p is Promise<unknown> => p !== undefined);
  const result = Promise.all(prior).then(fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  for (const k of keys) queues.set(k, settled);
  void settled.then(() => {
    for (const k of keys) if (queues.get(k) === settled) queues.delete(k);
  });
  return result;
}

interface Write<T> {
  /** Tasks the write touches: writes to the same tasks are sent in order. */
  keys: readonly string[];
  patches?: ReadonlyMap<string, TaskPatch>;
  creates?: readonly Task[];
  send(idempotencyKey: string): Promise<T>;
  apply(result: T): void;
  /** The task's title, for messages. */
  subject: string;
  /** On 409 task-conflict: sends the change again over the server's current value ("Use mine"). */
  force?: () => void;
  /** A 404: the task is gone, which a delete counts as done. */
  notFoundIsDone?: boolean;
  /** Called after a failure was reported (quick add gives the typed text back). */
  onError?(e: unknown): void;
}

/** Sends a write with its optimistic layer; resolves to the result, or null after a failure (reported). */
export async function runWrite<T>(write: Write<T>, store: TaskStore = taskStore, key: string = newIdempotencyKey()): Promise<T | null> {
  const overlay = write.patches || write.creates ? store.addOverlay(write.patches ?? new Map(), write.creates) : null;
  try {
    const result = await serialize(write.keys, () => write.send(key));
    write.apply(result);
    return result;
  } catch (e) {
    reportFailure(e, write, store, key);
    write.onError?.(e);
    return null;
  } finally {
    if (overlay !== null) store.dropOverlay(overlay);
  }
}

function reportFailure<T>(e: unknown, write: Write<T>, store: TaskStore, key: string): void {
  const subject = `“${write.subject}”`;
  if (isProblem(e, 'task-conflict')) {
    const problem = e.problem as TaskConflictProblem;
    if (problem.task) store.upsert([problem.task]);
    if (problem.list) store.upsertLists([problem.list]);
    toast(`${subject} was changed on another device, so this change was not made.`, {
      kind: 'error',
      action: write.force ? { label: 'Use mine', run: write.force } : undefined,
      timeout: 12_000,
    });
    return;
  }
  if (isProblem(e, 'not-found')) {
    store.remove(write.keys.filter((k) => !k.startsWith(PENDING_PREFIX)));
    invalidateTaskViews();
    if (!write.notFoundIsDone) toast(`${subject} no longer exists.`);
    return;
  }
  invalidateTaskViews();
  if (isProblem(e, 'malformed-file')) {
    const path = e.problem.path;
    toast(`The list file cannot be changed: ${e.problem.reason ?? e.problem.detail ?? 'it is not a valid task list'}.`, {
      kind: 'error',
      action: path ? { label: 'Open file', run: () => openPath(path) } : undefined,
      timeout: 12_000,
    });
    return;
  }
  if (isTransient(e)) {
    // Sent again by itself when the connection is back; until then the toast stays, since its
    // Retry may hold the only copy of what was typed (quick add).
    const retry = (): void => {
      waiting.delete(id);
      useToasts.getState().dismiss(id);
      void runWrite(write, store, key);
    };
    const id = toast(`${subject}: not saved, you're offline.`, { action: { label: 'Retry', run: retry }, timeout: 0 });
    waiting.set(id, retry);
    watchConnection();
    return;
  }
  toastError(e, subject);
}

/** Writes that failed offline, by their toast: each is sent again (same key) when the connection is back. */
const waiting = new Map<number, () => void>();
let unwatch: (() => void) | null = null;

function watchConnection(): void {
  if (unwatch) return;
  unwatch = useUi.subscribe((state, prev) => {
    if (state.connection !== 'live' || prev.connection === 'live') return;
    for (const retry of [...waiting.values()]) retry();
  });
}

/** Forgets the writes waiting for the connection (tests). */
export function resetWaitingWrites(): void {
  waiting.clear();
  unwatch?.();
  unwatch = null;
}

// ---------- tasks ----------

export const PENDING_PREFIX = 'pending-';
let pendingSeq = 1;

/** True for the placeholder of a task being created (not on the server yet). */
export function isPending(task: Pick<Task, 'id'>): boolean {
  return task.id.startsWith(PENDING_PREFIX);
}

function siblings(store: TaskStore, listId: string, parentId: string | null, sectionId: string | null, exclude?: string): Task[] {
  return [...store.tasks().values()]
    .filter((t) => t.listId === listId && !t.archived && t.id !== exclude && t.parentId === parentId && (parentId !== null || t.sectionId === sectionId))
    .sort(compareOrder);
}

/** A key between two neighbours, or null when their keys are unusable (the server renumbers then). */
function keyFor(prev: Task | undefined, next: Task | undefined): string | null {
  const a = prev?.order ?? null;
  const b = next?.order ?? null;
  if ((a !== null && !isValidKey(a)) || (b !== null && !isValidKey(b))) return null;
  if (a !== null && b !== null && compareKeys(a, b) >= 0) return null;
  try {
    return keyBetween(a, b);
  } catch {
    return null;
  }
}

/** The Inbox, where a task without a list goes (API.md §20.4). */
export function inboxList(store: TaskStore = taskStore): TaskList | undefined {
  return store.lists().find((l) => l.path === 'Tasks/Inbox.tasks');
}

/** POST /api/tasks. The task shows at once when its list is known. Resolves to the created task. */
export async function createTask(req: CreateTaskRequest, store: TaskStore = taskStore, onError?: (e: unknown) => void): Promise<Task | null> {
  const parent = req.parentId ? store.task(req.parentId) : undefined;
  const listId = parent?.listId ?? req.listId ?? inboxList(store)?.id;
  let creates: Task[] = [];
  if (listId) {
    const parentId = req.parentId ?? null;
    const sectionId = parentId ? null : (req.sectionId ?? null);
    const last = siblings(store, listId, parentId, sectionId).at(-1);
    creates = [
      {
        id: PENDING_PREFIX + pendingSeq++,
        listId,
        sectionId,
        parentId,
        title: req.title.trim(),
        notes: req.notes ?? null,
        status: 'open',
        priority: req.priority ?? 0,
        due: req.due ?? null,
        start: req.start ?? null,
        recurrence: req.recurrence ?? null,
        reminders: req.reminders ?? [],
        tags: req.tags ?? [],
        links: req.links ?? [],
        order: keyFor(last, undefined) ?? '~',
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        archived: false,
      },
    ];
  }
  const result = await runWrite(
    {
      keys: req.parentId ? [req.parentId] : [],
      creates,
      send: (key) => taskApi.create(req, key),
      apply: (r) => applyTaskWriteResult(r, store),
      subject: req.title.trim(),
      onError,
    },
    store,
  );
  return result?.task ?? null;
}

const FIELDS: ReadonlyArray<keyof TaskFields> = ['title', 'notes', 'status', 'priority', 'due', 'start', 'recurrence', 'reminders', 'tags', 'links', 'listId', 'sectionId', 'parentId'];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * PATCH /api/tasks/{id}: the changed fields, with the values the user saw (`base`, by default
 * the task as shown when the change was made). Fields already as requested are not sent.
 */
export async function updateTask(task: Task, changes: TaskFields, base?: TaskFields, store: TaskStore = taskStore): Promise<Task | null> {
  if (isPending(task)) return null;
  const send: TaskFields = {};
  const seen: TaskFields = {};
  for (const field of FIELDS) {
    if (!(field in changes)) continue;
    const value = changes[field];
    if (sameValue(value, task[field])) continue;
    Object.assign(send, { [field]: value });
    Object.assign(seen, { [field]: base && field in base ? base[field] : task[field] });
  }
  if (Object.keys(send).length === 0) return task;

  const patch: Partial<Task> = { ...(send as Partial<Task>) };
  if (send.status !== undefined) patch.completedAt = send.status === 'open' ? null : new Date().toISOString();
  const patches = new Map<string, TaskPatch>([[task.id, patch]]);
  if (send.listId !== undefined) {
    // The subtasks move along; the task goes to the other list's top level unless a parent is given.
    if (!('parentId' in send)) patch.parentId = null;
    if (!('sectionId' in send)) patch.sectionId = null;
    for (const d of descendants(task.id, childrenByParent(store.tasks().values()))) patches.set(d.id, { listId: send.listId, sectionId: null });
  }
  if (send.parentId !== undefined && send.parentId !== null) patch.sectionId = null;

  const result = await runWrite(
    {
      keys: [task.id],
      patches,
      send: (key) => taskApi.update(task.id, { changes: send, base: seen }, key),
      apply: (r) => applyTaskWriteResult(r, store),
      subject: task.title,
      force: () => {
        const current = store.task(task.id);
        if (current) void updateTask(current, changes, undefined, store);
      },
    },
    store,
  );
  return result?.task ?? null;
}

/** Tasks whose completion is being sent: a second tap must not complete the next occurrence too. */
const completing = new Set<string>();

/**
 * The optimistic outcome of completing a task on `day`: closed with its open subtasks, or, for a
 * recurring task, rolled forward to its next date (computed here as the server will, with its
 * closed subtasks reopened), or left as it is when the rule cannot be evaluated here.
 */
function completionPatches(task: Task, roll: Partial<Task> | null | undefined, store: TaskStore): Map<string, TaskPatch> {
  const now = new Date().toISOString();
  const below = descendants(task.id, childrenByParent(store.tasks().values()));
  if (roll === undefined) return new Map([[task.id, {}]]);
  if (roll) return new Map<string, TaskPatch>([[task.id, roll], ...below.filter((d) => d.status !== 'open').map((d): [string, TaskPatch] => [d.id, { status: 'open', completedAt: null }])]);
  return new Map<string, TaskPatch>([[task.id, { status: 'done', completedAt: now }], ...below.filter((d) => d.status === 'open').map((d): [string, TaskPatch] => [d.id, { status: 'done', completedAt: now }])]);
}

/** POST /api/tasks/{id}/complete, with Undo. A recurring task rolls forward to its next date. */
export async function completeTask(task: Task, store: TaskStore = taskStore): Promise<TaskWriteResult | null> {
  if (isPending(task) || task.status !== 'open' || completing.has(task.id)) return null;
  completing.add(task.id);
  const day = localToday();
  // The subtasks' statuses before, so Undo can put back exactly those the completion changed.
  const prior = new Map(descendants(task.id, childrenByParent(store.tasks().values())).map((d) => [d.id, store.knownTask(d.id)?.status ?? d.status]));
  let result: TaskWriteResult | null;
  try {
    // Only a recurring task waits (for the rrule chunk), so a plain one is checked off at once.
    const roll = task.recurrence ? await loadRecurrence().then((m) => m.rollForward(task, day), () => undefined) : null;
    const patches = completionPatches(task, roll, store);
    result = await runWrite(
      {
        keys: [task.id],
        patches,
        send: (key) => taskApi.complete(task.id, { date: day, base: { due: task.due, start: task.start } }, key),
        apply: (r) => applyTaskWriteResult(r, store),
        subject: task.title,
      },
      store,
    );
  } finally {
    completing.delete(task.id);
  }
  if (!result) return null;
  const after = result.task;
  const subtasks = result.changed.filter((c) => prior.has(c.id));
  if (result.rolledForward && after) {
    const next = after.due ?? after.start;
    // The roll-forward reopened the closed subtasks for the next round; Undo closes them again.
    const reopened = subtasks.filter((c) => c.status === 'open' && prior.get(c.id) !== 'open');
    toast(next ? `“${task.title}” is next due ${formatTaskDate(next, localToday())}` : `“${task.title}” rolled forward`, {
      action: {
        label: 'Undo',
        run: () => {
          void updateTask(after, { due: task.due, start: task.start, reminders: task.reminders, recurrence: task.recurrence }, undefined, store);
          for (const c of reopened) void updateTask(store.task(c.id) ?? c, { status: prior.get(c.id)! }, { status: 'open' }, store);
        },
      },
    });
  } else if (after && after.status !== 'open') {
    // The completion closed the subtasks that were open; Undo reopens those (and only those).
    const closed = subtasks.filter((c) => c.status !== 'open' && prior.get(c.id) === 'open');
    toast(`Completed “${task.title}”`, {
      action: {
        label: 'Undo',
        run: () => {
          void uncompleteTask(after, store);
          for (const c of closed) void uncompleteTask(store.task(c.id) ?? c, store);
        },
      },
    });
  }
  return result;
}

/** POST /api/tasks/{id}/uncomplete. */
export async function uncompleteTask(task: Task, store: TaskStore = taskStore): Promise<Task | null> {
  if (isPending(task) || task.status === 'open') return null;
  const result = await runWrite(
    {
      keys: [task.id],
      patches: new Map([[task.id, { status: 'open', completedAt: null }]]),
      send: (key) => taskApi.uncomplete(task.id, key),
      apply: (r) => applyTaskWriteResult(r, store),
      subject: task.title,
    },
    store,
  );
  return result?.task ?? null;
}

export function toggleTask(task: Task, store: TaskStore = taskStore): void {
  if (task.status === 'open') void completeTask(task, store);
  else void uncompleteTask(task, store);
}

/**
 * Cancels an open task (PATCH status: cancelled), with Undo. Unlike completing, it never rolls a
 * recurring task forward (it stops repeating) and leaves the subtasks as they are.
 */
export async function cancelTask(task: Task, store: TaskStore = taskStore): Promise<Task | null> {
  if (isPending(task) || task.status !== 'open') return null;
  const after = await updateTask(task, { status: 'cancelled' }, { status: 'open' }, store);
  if (after?.status === 'cancelled') toast(`Cancelled “${task.title}”`, { action: { label: 'Undo', run: () => void uncompleteTask(store.task(after.id) ?? after, store) } });
  return after;
}

/** Sets a task's status (a board move): done goes through complete (recurrence, subtasks, Undo), open through uncomplete. */
export function setTaskStatus(task: Task, status: TaskStatus, store: TaskStore = taskStore): void {
  if (status === task.status) return;
  if (status === 'done' && task.status === 'open') void completeTask(task, store);
  else if (status === 'cancelled' && task.status === 'open') void cancelTask(task, store);
  else if (status === 'open') void uncompleteTask(task, store);
  else void updateTask(task, { status }, { status: task.status }, store);
}

/** DELETE /api/tasks/{id}, after a confirmation that names the subtasks going with it. */
export async function deleteTask(task: Task, store: TaskStore = taskStore, confirm = confirmAction): Promise<boolean> {
  if (isPending(task)) return false;
  const below = descendants(task.id, childrenByParent(store.tasks().values()));
  const ok = await confirm({
    title: 'Delete task?',
    message:
      `“${task.title}”` +
      (below.length ? ` and its ${below.length === 1 ? 'subtask' : `${below.length} subtasks`} will be deleted.` : ' will be deleted.') +
      ' The list’s history keeps a copy.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  const patches = new Map<string, TaskPatch>([[task.id, null], ...below.map((d): [string, TaskPatch] => [d.id, null])]);
  const result = await runWrite(
    {
      keys: [task.id],
      patches,
      send: (key) => taskApi.remove(task.id, key),
      apply: (r) => applyTaskWriteResult(r, store),
      subject: task.title,
      notFoundIsDone: true,
    },
    store,
  );
  return result !== null;
}

export interface Placement {
  parentId: string | null;
  /** Top-level tasks only. */
  sectionId: string | null;
  /** The sibling to follow; null: first. */
  afterId: string | null;
}

/** POST /api/tasks/reorder for one task: a new place among its siblings, section or parent. */
export async function moveTask(task: Task, to: Placement, store: TaskStore = taskStore): Promise<boolean> {
  if (isPending(task)) return false;
  const sectionId = to.parentId === null ? to.sectionId : null;
  const place = siblings(store, task.listId, to.parentId, sectionId, task.id);
  const at = to.afterId === null ? 0 : place.findIndex((t) => t.id === to.afterId) + 1;
  if (to.afterId !== null && at === 0) return false;
  if (task.parentId === to.parentId && (to.parentId !== null || task.sectionId === sectionId)) {
    // Dropped where it already is.
    const current = siblings(store, task.listId, to.parentId, sectionId);
    const index = current.findIndex((t) => t.id === task.id);
    if ((index === 0 ? null : current[index - 1]?.id) === to.afterId) return true;
  }
  const patch: Partial<Task> = { parentId: to.parentId, sectionId };
  const order = keyFor(place[at - 1], place[at]);
  if (order !== null) patch.order = order;
  const result = await runWrite(
    {
      keys: [task.id],
      patches: new Map([[task.id, patch]]),
      send: (key) => taskApi.reorder({ listId: task.listId, sectionId, parentId: to.parentId, ids: [task.id], after: to.afterId }, key),
      apply: (r) => applyTaskWriteResult(r, store),
      subject: task.title,
    },
    store,
  );
  return result !== null;
}

// ---------- lists and sections (not optimistic: the server names files and ids) ----------

async function listWrite(send: (key: string) => Promise<TaskListWriteResult>, subject: string, store: TaskStore = taskStore): Promise<TaskListWriteResult | null> {
  return runWrite({ keys: [], send, apply: (r) => applyTaskListWriteResult(r, store), subject }, store);
}

export async function createList(name: string, store: TaskStore = taskStore): Promise<TaskList | null> {
  const result = await listWrite((key) => taskApi.createList({ name: name.trim() }, key), name.trim(), store);
  return result?.lists[0] ?? null;
}

/**
 * PATCH /api/tasks/lists/{id}. A new name renames the file too, and the server may rewrite links
 * to it in other notes: dirty notes are saved first, and since the result does not list those
 * rewrites, the tree is fetched again afterwards so open notes pick them up before they save.
 */
export async function updateList(list: TaskList, changes: TaskListFields, store: TaskStore = taskStore): Promise<TaskList | null> {
  const base: TaskListFields = {};
  for (const field of Object.keys(changes) as Array<keyof TaskListFields>) Object.assign(base, { [field]: list[field] });
  const renaming = changes.name !== undefined && changes.name !== list.name;
  if (renaming) await documents.flushAll();
  const result = await listWrite((key) => taskApi.updateList(list.id, { changes, base }, key), list.name, store);
  if (result?.moved) void refetchTree().then(() => documents.revalidateAll(), () => undefined);
  return result?.lists.find((l) => l.id === list.id) ?? null;
}

/** DELETE /api/tasks/lists/{id}: the file goes to the trash, with Restore there. */
export async function deleteList(list: TaskList, store: TaskStore = taskStore, confirm = confirmAction): Promise<boolean> {
  const ok = await confirm({
    title: 'Delete list?',
    message: `“${list.name}” and its tasks move to the trash (${displayName(list.path)}), from where they can be restored.`,
    confirmLabel: 'Delete list',
    danger: true,
  });
  if (!ok) return false;
  const session = documents.get(list.path);
  await session?.flush();
  const result = await listWrite((key) => taskApi.deleteList(list.id, key), list.name, store);
  if (!result) return false;
  store.removeList(list.id);
  if (session) documents.close(session);
  if (activePath() === null && appPathname() === `/x/tasks/list/${encodeURIComponent(list.id)}`) navigateTo('/x/tasks', { replace: true });
  toast(`Moved “${list.name}” to the trash`);
  return true;
}

export async function createSection(list: TaskList, name: string, store: TaskStore = taskStore): Promise<boolean> {
  return (await listWrite((key) => taskApi.createSection(list.id, { name: name.trim() }, key), list.name, store)) !== null;
}

export async function renameSection(list: TaskList, sectionId: string, name: string, store: TaskStore = taskStore): Promise<boolean> {
  return (await listWrite((key) => taskApi.renameSection(list.id, sectionId, { name: name.trim() }, key), list.name, store)) !== null;
}

/** Deletes a section; its tasks stay in the list without a section (they arrive as task.changed elsewhere). */
export async function deleteSection(list: TaskList, sectionId: string, store: TaskStore = taskStore): Promise<boolean> {
  const result = await listWrite((key) => taskApi.deleteSection(list.id, sectionId, key), list.name, store);
  // The server answers with the list only; the tasks it moved out of the section are refetched.
  if (result) invalidateTaskViews();
  return result !== null;
}

/** POST /api/tasks/lists/{id}/sections/reorder for one section: right after `afterId` (null: first). */
export async function moveSection(list: TaskList, sectionId: string, afterId: string | null, store: TaskStore = taskStore): Promise<boolean> {
  return (await listWrite((key) => taskApi.reorderSections(list.id, { ids: [sectionId], after: afterId }, key), list.name, store)) !== null;
}

/** POST /api/tasks/lists/reorder for one list. */
export async function moveList(list: TaskList, afterId: string | null, store: TaskStore = taskStore): Promise<boolean> {
  return (await listWrite((key) => taskApi.reorderLists({ ids: [list.id], after: afterId }, key), list.name, store)) !== null;
}
