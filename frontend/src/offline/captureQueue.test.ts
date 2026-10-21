import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../api/client';
import type { CaptureResult } from '../api/types';
import { flushQueue, IdbCaptureQueue, MemoryCaptureQueue, type QueuedCapture } from './captureQueue';

const item = (text: string, key = 'key-' + text): QueuedCapture => ({
  key,
  request: { text, target: 'inbox', date: '2026-10-16', time: '10:00', tz: 'UTC' },
  at: 1000,
});

const result = (path = 'Inbox.md'): CaptureResult => ({
  file: { path, name: path, basename: 'Inbox', extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] },
  created: false,
  createdFolders: [],
  target: 'inbox',
  attachment: null,
});

describe('capture queue', () => {
  it('sends in order, each with its own idempotency key, and empties the queue', async () => {
    const store = new MemoryCaptureQueue();
    await store.add([item('one'), item('two')]);
    const send = vi.fn(async (_i: QueuedCapture) => result());
    const onSent = vi.fn();
    const report = await flushQueue({ store, send, onSent });
    expect(send.mock.calls.map(([i]) => [i.request.text, i.key])).toEqual([
      ['one', 'key-one'],
      ['two', 'key-two'],
    ]);
    expect(report.sent).toHaveLength(2);
    expect(report.waiting).toBe(0);
    expect(onSent).toHaveBeenCalledTimes(2);
    expect(await store.list()).toEqual([]);
  });

  it('keeps everything from the first unreachable attempt on, for the next try', async () => {
    const store = new MemoryCaptureQueue();
    await store.add([item('one'), item('two'), item('three')]);
    const send = vi.fn(async (i: QueuedCapture) => {
      if (i.request.text === 'two') throw new TransientError('offline');
      return result();
    });
    const report = await flushQueue({ store, send, onSent: () => {} });
    expect(report.sent.map((s) => s.item.request.text)).toEqual(['one']);
    expect(report.waiting).toBe(2);
    expect((await store.list()).map((i) => i.request.text)).toEqual(['two', 'three']);
    expect(send).toHaveBeenCalledTimes(2);
    // Next time the same keys go out again: a lost response cannot append twice.
    send.mockImplementation(async () => result());
    await flushQueue({ store, send, onSent: () => {} });
    expect(send.mock.calls.slice(2).map(([i]) => i.key)).toEqual(['key-two', 'key-three']);
    expect(await store.list()).toEqual([]);
  });

  it('keeps a refused capture aside with the reason and goes on', async () => {
    const store = new MemoryCaptureQueue();
    await store.add([item('bad'), item('good')]);
    const send = vi.fn(async (i: QueuedCapture) => {
      if (i.request.text === 'bad') throw new ApiError({ type: 'urn:notesapp:problem:too-large', title: 'Too large', status: 413, code: 'too-large', limit: 5 });
      return result();
    });
    const report = await flushQueue({ store, send, onSent: () => {} });
    expect(report.failed).toHaveLength(1);
    expect(report.sent).toHaveLength(1);
    const left = await store.list();
    expect(left).toHaveLength(1);
    expect(left[0].request.text).toBe('bad');
    expect(left[0].error).toMatch(/too large/i);
    // A refused capture is not sent again by itself.
    send.mockClear();
    await flushQueue({ store, send, onSent: () => {} });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps captures, files included, in IndexedDB across page loads', async () => {
    const factory = new IDBFactory();
    const first = new IdbCaptureQueue(factory);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const ids = await first.add([item('text'), { ...item('photo'), file: { name: 'p.png', type: 'image/png', blob } }]);
    expect(ids).toHaveLength(2);
    const second = new IdbCaptureQueue(factory);
    const list = await second.list();
    expect(list.map((i) => i.request.text)).toEqual(['text', 'photo']);
    expect(list[1].file?.name).toBe('p.png');
    await second.remove(list[0].id!);
    expect((await second.list()).map((i) => i.request.text)).toEqual(['photo']);
  });
});
