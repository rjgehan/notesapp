import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCARDED_MAX_AGE_MS, DRAFT_MAX_AGE_MS, IdbDraftStore, TabCoordinator, type ChannelLike, type DraftRecord } from './drafts';

const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  path: 'a.md',
  clientId: 'tab-1',
  baseVersion: 'v1',
  baseText: 'base',
  text: 'text',
  eol: 'lf',
  at: Date.now(),
  ...over,
});

describe('IdbDraftStore', () => {
  let store: IdbDraftStore;

  beforeEach(() => {
    store = new IdbDraftStore(new IDBFactory());
  });

  it('writes, lists and removes drafts per path and client', async () => {
    await store.put(draft());
    await store.put(draft({ clientId: 'tab-2', text: 'other' }));
    await store.put(draft({ path: 'b.md' }));
    expect((await store.listForPath('a.md')).map((d) => d.clientId).sort()).toEqual(['tab-1', 'tab-2']);
    await store.put(draft({ text: 'updated' }));
    expect((await store.listForPath('a.md')).find((d) => d.clientId === 'tab-1')?.text).toBe('updated');
    await store.remove('a.md', 'tab-1');
    expect((await store.listForPath('a.md')).map((d) => d.clientId)).toEqual(['tab-2']);
  });

  it('re-keys drafts for a file and for everything under a folder', async () => {
    await store.put(draft({ path: 'A/x.md' }));
    await store.put(draft({ path: 'A/sub/y.md' }));
    await store.put(draft({ path: 'AB/z.md' }));
    await store.rekey('A', 'B');
    expect(await store.listForPath('B/x.md')).toHaveLength(1);
    expect(await store.listForPath('B/sub/y.md')).toHaveLength(1);
    expect(await store.listForPath('AB/z.md')).toHaveLength(1);
    expect(await store.listForPath('A/x.md')).toHaveLength(0);
    await store.rekey('B/x.md', 'C.md');
    expect((await store.listForPath('C.md'))[0]).toMatchObject({ text: 'text', baseVersion: 'v1' });
  });

  it('never overwrites a draft already stored at the destination: it is kept as a discarded record (FE-4)', async () => {
    await store.put(draft({ path: 'Untitled.md', text: 'second note text' }));
    await store.put(draft({ path: 'Foo.md', text: 'foo body + unsaved foo edits' }));
    await store.rekey('Untitled.md', 'Foo.md');
    expect((await store.listForPath('Foo.md')).map((d) => d.text)).toEqual(['second note text']);
    expect((await store.listDiscarded()).map((d) => [d.path, d.text, d.reason])).toEqual([['Foo.md', 'foo body + unsaved foo edits', 'orphaned-draft']]);
  });

  it('lists every draft', async () => {
    await store.put(draft({ path: 'a.md' }));
    await store.put(draft({ path: 'Projects/b.md', clientId: 'tab-2' }));
    expect((await store.listAll()).map((d) => d.path).sort()).toEqual(['Projects/b.md', 'a.md']);
  });

  it('keeps discarded edits and gives them back once', async () => {
    const id = await store.discard({ path: 'a.md', text: 'mine', eol: 'crlf', at: Date.now(), reason: 'take-theirs' });
    expect((await store.listDiscarded()).map((d) => d.text)).toEqual(['mine']);
    expect(await store.takeDiscarded(id)).toMatchObject({ text: 'mine', eol: 'crlf' });
    expect(await store.takeDiscarded(id)).toBeNull();
  });

  it('prunes old drafts and discarded edits', async () => {
    const now = Date.now();
    await store.put(draft({ at: now - DRAFT_MAX_AGE_MS - 1 }));
    await store.put(draft({ clientId: 'fresh', at: now }));
    await store.discard({ path: 'a.md', text: 'old', eol: 'lf', at: now - DISCARDED_MAX_AGE_MS - 1, reason: 'discard' });
    await store.discard({ path: 'a.md', text: 'new', eol: 'lf', at: now, reason: 'discard' });
    await store.prune(now);
    expect((await store.listForPath('a.md')).map((d) => d.clientId)).toEqual(['fresh']);
    expect((await store.listDiscarded()).map((d) => d.text)).toEqual(['new']);
  });

  it('reports a quota failure to the caller', async () => {
    const failing = new IdbDraftStore(new IDBFactory());
    await failing.put(draft());
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    await expect(failing.put(draft({ text: 'big' }))).rejects.toThrow(/Quota/);
    spy.mockRestore();
  });
});

/** An in-memory BroadcastChannel bus. */
function bus() {
  const members = new Set<{ listener?: (ev: MessageEvent) => void }>();
  return () => {
    const self: { listener?: (ev: MessageEvent) => void } = {};
    members.add(self);
    const channel: ChannelLike = {
      postMessage(message) {
        for (const m of members) if (m !== self) queueMicrotask(() => m.listener?.(new MessageEvent('message', { data: message })));
      },
      addEventListener(_type, listener) {
        self.listener = listener;
      },
      close() {
        members.delete(self);
      },
    };
    return channel;
  };
}

describe('TabCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects the live tabs that own drafts for a path', async () => {
    const channel = bus();
    const a = new TabCoordinator('tab-a', () => false, channel());
    new TabCoordinator('tab-b', (p) => p === 'x.md', channel());
    new TabCoordinator('tab-c', () => false, channel());
    const owners = a.liveOwners('x.md', 100);
    await vi.advanceTimersByTimeAsync(100);
    expect([...(await owners)]).toEqual(['tab-b']);
  });

  it('answers immediately without BroadcastChannel', async () => {
    const solo = new TabCoordinator('tab-a', () => true, null);
    expect((await solo.liveOwners('x.md')).size).toBe(0);
  });
});
