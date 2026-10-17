import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../api/client';
import { queryClient } from '../api/queryClient';
import type { FileEntry, Problem, Task, TaskWriteResult, TreeResponse } from '../api/types';
import { useToasts } from '../state/toasts';
import { taskApi } from './api';
import { completeTask, createTask, deleteTask, isPending, moveTask, updateTask } from './mutations';
import { TaskStore } from './store';
import { makeList, makeTask } from './testing';

function result(task: Task | null, extra: Partial<TaskWriteResult> = {}): TaskWriteResult {
  return { task, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [], ...extra };
}

function problem(status: number, code: Problem['code'], extra: Record<string, unknown> = {}): ApiError {
  return new ApiError({ type: `urn:notesapp:problem:${code}`, title: code, status, code, ...extra } as Problem);
}

/** A promise with its resolve and reject, to hold a request open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const toasts = () => useToasts.getState().toasts.map((t) => t.message);
let store: TaskStore;

beforeEach(() => {
  store = new TaskStore();
  store.setLists([makeList(), makeList({ id: 'INBOX', name: 'Inbox', order: 'Zz', path: 'Tasks/Inbox.tasks' })], [], store.generation());
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  queryClient.clear();
});

describe('optimistic updates (DESIGN §6.22)', () => {
  it('shows a change at once, sends it with the value seen as base, then applies the result', async () => {
    const t = makeTask({ id: 'A', title: 'Pay rent' });
    store.upsert([t]);
    const held = deferred<TaskWriteResult>();
    const update = vi.spyOn(taskApi, 'update').mockReturnValue(held.promise);
    const done = updateTask(t, { title: 'Pay the rent' }, undefined, store);
    expect(store.task('A')?.title).toBe('Pay the rent');
    expect(store.knownTask('A')?.title).toBe('Pay rent');
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith('A', { changes: { title: 'Pay the rent' }, base: { title: 'Pay rent' } }, expect.any(String));
    held.resolve(result({ ...t, title: 'Pay the rent', updatedAt: '2026-10-17T10:00:00.000Z' }));
    await done;
    expect(store.knownTask('A')?.title).toBe('Pay the rent');
    expect(store.hasPending('A')).toBe(false);
  });

  it('rolls back when the server refuses, keeping changes that arrived meanwhile', async () => {
    const t = makeTask({ id: 'A', title: 'Pay rent', priority: 0 });
    store.upsert([t]);
    const held = deferred<TaskWriteResult>();
    vi.spyOn(taskApi, 'update').mockReturnValue(held.promise);
    const done = updateTask(t, { priority: 3 }, undefined, store);
    expect(store.task('A')?.priority).toBe(3);
    // Another device renames it while the request runs.
    store.upsert([{ ...t, title: 'Pay the rent' }]);
    held.reject(problem(500, 'io-error', { detail: 'disk failed' }));
    expect(await done).toBeNull();
    expect(store.task('A')).toMatchObject({ priority: 0, title: 'Pay the rent' });
    expect(toasts().some((m) => m.includes('disk failed'))).toBe(true);
  });

  it('shows a field conflict, takes the server’s task, and offers to apply the change anyway', async () => {
    const t = makeTask({ id: 'A', title: 'Pay rent' });
    store.upsert([t]);
    const server = { ...t, title: 'Pay rent today' };
    const update = vi
      .spyOn(taskApi, 'update')
      .mockRejectedValueOnce(problem(409, 'task-conflict', { task: server, fields: ['title'] }))
      .mockResolvedValueOnce(result({ ...server, title: 'Pay the rent' }));
    expect(await updateTask(t, { title: 'Pay the rent' }, undefined, store)).toBeNull();
    expect(store.task('A')?.title).toBe('Pay rent today');
    const toast = useToasts.getState().toasts.at(-1)!;
    expect(toast.message).toContain('changed on another device');
    toast.action!.run();
    await vi.waitFor(() => expect(store.task('A')?.title).toBe('Pay the rent'));
    // "Use mine" sends the change again, over the value the server has now.
    expect(update.mock.calls[1][1]).toEqual({ changes: { title: 'Pay the rent' }, base: { title: 'Pay rent today' } });
  });

  it('sends edits of one task one after another, each based on the previous', async () => {
    const t = makeTask({ id: 'A', title: 'one' });
    store.upsert([t]);
    const first = deferred<TaskWriteResult>();
    const update = vi
      .spyOn(taskApi, 'update')
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async (_id, req) => result({ ...t, title: String(req.changes.title) }));
    const a = updateTask(t, { title: 'two' }, undefined, store);
    const b = updateTask(store.task('A')!, { title: 'three' }, undefined, store);
    await Promise.resolve();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(store.task('A')?.title).toBe('three');
    first.resolve(result({ ...t, title: 'two' }));
    await Promise.all([a, b]);
    expect(update.mock.calls[1][1]).toEqual({ changes: { title: 'three' }, base: { title: 'two' } });
    expect(store.task('A')?.title).toBe('three');
  });

  it('skips a change to the value the task already has', async () => {
    const t = makeTask({ id: 'A', tags: ['home'] });
    store.upsert([t]);
    const update = vi.spyOn(taskApi, 'update');
    expect(await updateTask(t, { tags: ['home'] }, undefined, store)).toBe(t);
    expect(update).not.toHaveBeenCalled();
  });

  it('offers Retry when offline, with the same idempotency key', async () => {
    const t = makeTask({ id: 'A', title: 'x' });
    store.upsert([t]);
    const update = vi.spyOn(taskApi, 'update').mockRejectedValueOnce(new TransientError('Failed to fetch')).mockResolvedValueOnce(result({ ...t, title: 'y' }));
    await updateTask(t, { title: 'y' }, undefined, store);
    expect(store.task('A')?.title).toBe('x');
    useToasts.getState().toasts.at(-1)!.action!.run();
    await vi.waitFor(() => expect(store.task('A')?.title).toBe('y'));
    expect(update.mock.calls[0][2]).toBe(update.mock.calls[1][2]);
  });
});

describe('completing, creating, deleting and moving', () => {
  it('completes a task and its open subtasks at once, then offers Undo', async () => {
    const p = makeTask({ id: 'P', due: '2026-10-17' });
    const c = makeTask({ id: 'C', parentId: 'P' });
    store.upsert([p, c]);
    const held = deferred<TaskWriteResult>();
    const complete = vi.spyOn(taskApi, 'complete').mockReturnValue(held.promise);
    const done = completeTask(p, store);
    expect(store.task('P')?.status).toBe('done');
    expect(store.task('C')?.status).toBe('done');
    await Promise.resolve();
    expect(complete.mock.calls[0][1]).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), base: { due: '2026-10-17', start: null } });
    held.resolve(result({ ...p, status: 'done', completedAt: '2026-10-17T10:00:00.000Z' }, { changed: [{ ...c, status: 'done', completedAt: '2026-10-17T10:00:00.000Z' }] }));
    await done;
    expect(toasts().at(-1)).toContain('Completed');
    const uncomplete = vi.spyOn(taskApi, 'uncomplete').mockResolvedValue(result({ ...p, status: 'open' }));
    useToasts.getState().toasts.at(-1)!.action!.run();
    await vi.waitFor(() => expect(store.task('P')?.status).toBe('open'));
    expect(uncomplete).toHaveBeenCalledWith('P', expect.any(String));
  });

  it('rolls a recurring task forward and says when it is next due', async () => {
    const t = makeTask({ id: 'R', due: '2026-10-17', recurrence: { rrule: 'FREQ=WEEKLY', from: 'due' } });
    const sub = makeTask({ id: 'S', parentId: 'R' });
    store.upsert([t, sub]);
    vi.spyOn(taskApi, 'complete').mockResolvedValue(result({ ...t, due: '2026-10-24' }, { rolledForward: true }));
    const done = completeTask(t, store);
    // Subtasks of a recurring task are not closed: they reopen for the next round anyway.
    expect(store.task('S')?.status).toBe('open');
    await done;
    expect(store.task('R')).toMatchObject({ status: 'open', due: '2026-10-24' });
    expect(toasts().at(-1)).toContain('next due');
  });

  it('shows a new task in its list at once, then swaps in the created one', async () => {
    const held = deferred<TaskWriteResult>();
    const create = vi.spyOn(taskApi, 'create').mockReturnValue(held.promise);
    const done = createTask({ title: ' Buy milk ', tags: ['shop'] }, store);
    const pending = [...store.tasks().values()].find(isPending)!;
    expect(pending).toMatchObject({ listId: 'INBOX', title: 'Buy milk', tags: ['shop'] });
    const created = makeTask({ id: 'NEW', listId: 'INBOX', title: 'Buy milk' });
    held.resolve(result(created));
    expect(await done).toEqual(created);
    expect(create).toHaveBeenCalledWith({ title: ' Buy milk ', tags: ['shop'] }, expect.any(String));
    expect([...store.tasks().values()].some(isPending)).toBe(false);
    expect(store.task('NEW')).toBeDefined();
  });

  it('removes the placeholder and reports a failed create', async () => {
    vi.spyOn(taskApi, 'create').mockRejectedValue(problem(400, 'bad-request', { detail: 'title too long' }));
    const onError = vi.fn();
    expect(await createTask({ title: 'x', listId: 'L1' }, store, onError)).toBeNull();
    expect([...store.tasks().values()].some(isPending)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('deletes after confirmation, and a task already gone counts as deleted', async () => {
    const t = makeTask({ id: 'A' });
    const c = makeTask({ id: 'B', parentId: 'A' });
    store.upsert([t, c]);
    const confirm = vi.fn().mockResolvedValue(true);
    vi.spyOn(taskApi, 'remove').mockRejectedValue(problem(404, 'not-found'));
    expect(await deleteTask(t, store, confirm)).toBe(false);
    expect(confirm.mock.calls[0][0].message).toContain('its subtask');
    expect(store.task('A')).toBeUndefined();
    expect(toasts()).toEqual([]);
    // Cancelled: nothing is sent.
    const kept = makeTask({ id: 'K' });
    store.upsert([kept]);
    const remove = vi.spyOn(taskApi, 'remove');
    remove.mockClear();
    expect(await deleteTask(kept, store, vi.fn().mockResolvedValue(false))).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('moves a task with a key between its new neighbours', async () => {
    const a = makeTask({ id: 'A', order: 'a0' });
    const b = makeTask({ id: 'B', order: 'a1' });
    const c = makeTask({ id: 'C', order: 'a2' });
    store.upsert([a, b, c]);
    const held = deferred<TaskWriteResult>();
    const reorder = vi.spyOn(taskApi, 'reorder').mockReturnValue(held.promise);
    const done = moveTask(c, { parentId: null, sectionId: null, afterId: 'A' }, store);
    expect(store.task('C')?.order).toBe('a0V');
    await Promise.resolve();
    expect(reorder).toHaveBeenCalledWith({ listId: 'L1', sectionId: null, parentId: null, ids: ['C'], after: 'A' }, expect.any(String));
    held.resolve(result(null, { changed: [{ ...c, order: 'a0V' }] }));
    expect(await done).toBe(true);
    // A drop where it already is sends nothing.
    reorder.mockClear();
    expect(await moveTask(store.task('C')!, { parentId: null, sectionId: null, afterId: 'A' }, store)).toBe(true);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('applies the list files of a result to the tree', async () => {
    const tree: TreeResponse = { eventId: 'b.1', folders: [], files: [] };
    queryClient.setQueryData(['tree'], tree);
    const file: FileEntry = { path: 'Tasks/Inbox.tasks', name: 'Inbox.tasks', basename: 'Inbox', extension: 'tasks', kind: 'text', size: 10, mtime: '2026-10-17T10:00:00.000Z', version: 'v1', aliases: [] };
    vi.spyOn(taskApi, 'create').mockResolvedValue(result(makeTask({ id: 'N', listId: 'INBOX' }), { files: [file], createdFolders: ['Tasks'] }));
    await createTask({ title: 'n' }, store);
    const after = queryClient.getQueryData<TreeResponse>(['tree'])!;
    expect(after.files.map((f) => f.path)).toEqual(['Tasks/Inbox.tasks']);
    expect(after.folders.map((f) => f.path)).toEqual(['Tasks']);
  });
});
