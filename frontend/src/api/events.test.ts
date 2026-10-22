import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportServerBuild, setReloader, setUnsavedProbe } from '../state/buildCheck';
import { useUi } from '../state/ui';
import type { EventSourceLike } from './endpoints';
import { EventStream, parseEventId, RECONNECT_BACKOFF_MS, type EventStreamDeps } from './events';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  readonly lastEventId: string | null;

  constructor(lastEventId: string | null) {
    this.lastEventId = lastEventId;
  }
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(l);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(name: string, data: unknown, id = '') {
    this.readyState = 1;
    for (const l of this.listeners.get(name) ?? []) l(new MessageEvent(name, { data: JSON.stringify(data), lastEventId: id }));
  }
  hello(over: Partial<{ resync: boolean; replayed: number; buildSha: string; eventId: string }> = {}, id = '') {
    this.emit('hello', { bootId: 'b', eventId: 'b.9', resync: false, replayed: 0, buildSha: 'dev', serverTime: '', ...over }, id);
  }
  fail(state: 0 | 2) {
    this.readyState = state;
    this.onerror?.(new Event('error'));
  }
}

function setup(extensions: string[] = []) {
  const sources: FakeSource[] = [];
  let resolveTree: ((eventId: string) => void) | null = null;
  let listener: (() => void) | null = null;
  const names = [...extensions];
  const deps = {
    clientId: 'client-0001',
    open: vi.fn((_id: string, last: string | null) => {
      const s = new FakeSource(last);
      sources.push(s);
      return s;
    }),
    apply: vi.fn(),
    refetchTree: vi.fn(() => new Promise<string>((r) => (resolveTree = r))),
    invalidateAll: vi.fn(),
    revalidateDocuments: vi.fn(),
    retryQueued: vi.fn(),
    onBuild: vi.fn(),
    onHealth: vi.fn(),
    onCaughtUp: vi.fn(),
    extensionNames: () => names,
    onExtensionsChanged: (fn: () => void) => {
      listener = fn;
      return () => (listener = null);
    },
  } satisfies EventStreamDeps;
  const stream = new EventStream(deps);
  return {
    stream,
    deps,
    sources,
    current: () => sources[sources.length - 1],
    tree: (eventId: string) => resolveTree?.(eventId),
    register(name: string) {
      names.push(name);
      listener?.();
    },
    applied: () => deps.apply.mock.calls.map((c) => `${c[0]}@${c[2]}`),
    caughtUp: () => deps.onCaughtUp.mock.calls.at(-1)?.[0],
    health: () => deps.onHealth.mock.calls.at(-1)?.[0] ?? 'live',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseEventId', () => {
  it('splits boot and sequence', () => {
    expect(parseEventId('mgbx3k2a.1042')).toEqual({ boot: 'mgbx3k2a', seq: 1042 });
    expect(parseEventId('')).toBeNull();
    expect(parseEventId('nodot')).toBeNull();
    expect(parseEventId('b.x')).toBeNull();
  });
});

describe('EventStream', () => {
  it('opens from the tree eventId and tracks the last event id (pings carry none)', () => {
    const t = setup();
    t.stream.start('b.5');
    expect(t.deps.open).toHaveBeenCalledWith('client-0001', 'b.5');
    t.current().hello({}, 'b.5');
    t.current().emit('file.changed', { file: { path: 'a.md' } }, 'b.6');
    t.current().emit('ping', { serverTime: '' });
    expect(t.stream.lastEventId).toBe('b.6');
    expect(t.applied()).toEqual(['file.changed@b.6']);
    // A recreated stream resumes from the last id.
    t.current().fail(2);
    vi.advanceTimersByTime(RECONNECT_BACKOFF_MS[0]);
    expect(t.deps.open).toHaveBeenLastCalledWith('client-0001', 'b.6');
    t.stream.stop();
  });

  it('stays Live and never reconnects on an idle stream that only receives pings for 2 minutes', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({}, 'b.1');
    for (let s = 0; s < 120; s += 20) {
      vi.advanceTimersByTime(20_000);
      t.current().emit('ping', { serverTime: '' });
    }
    vi.advanceTimersByTime(10_000);
    expect(t.deps.open).toHaveBeenCalledTimes(1);
    expect(t.deps.onHealth).not.toHaveBeenCalledWith('reconnecting');
    expect(t.health()).toBe('live');
    t.stream.stop();
  });

  it('recreates a stale stream (no event for more than 45 s)', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({}, 'b.1');
    vi.advanceTimersByTime(45_000);
    expect(t.health()).toBe('live');
    // The watchdog looks every 5 s.
    vi.advanceTimersByTime(5_000);
    expect(t.health()).toBe('reconnecting');
    expect(t.sources[0].closed).toBe(true);
    vi.advanceTimersByTime(RECONNECT_BACKOFF_MS[0]);
    expect(t.deps.open).toHaveBeenCalledTimes(2);
    t.stream.stop();
  });

  it('recreates a CLOSED stream with backoff (1, 2, 5, 10, then 30 s) and resets after hello', () => {
    const t = setup();
    t.stream.start('b.1');
    for (const [i, delay] of [1000, 2000, 5000, 10_000, 30_000, 30_000].entries()) {
      t.current().fail(2);
      expect(t.health()).toBe('reconnecting');
      vi.advanceTimersByTime(delay - 1);
      expect(t.deps.open).toHaveBeenCalledTimes(i + 1);
      vi.advanceTimersByTime(1);
      expect(t.deps.open).toHaveBeenCalledTimes(i + 2);
    }
    t.current().hello({}, 'b.1');
    expect(t.health()).toBe('live');
    t.current().fail(2);
    vi.advanceTimersByTime(1000);
    expect(t.deps.open).toHaveBeenCalledTimes(8);
    t.stream.stop();
  });

  it('leaves a CONNECTING stream to the browser retry', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().fail(0);
    expect(t.health()).toBe('reconnecting');
    vi.advanceTimersByTime(30_000);
    expect(t.deps.open).toHaveBeenCalledTimes(1);
    expect(t.sources[0].closed).toBe(false);
    t.stream.stop();
  });

  it('sets caughtUp after the replayed events (pings do not count), then retries queued saves', () => {
    const t = setup();
    t.stream.start('b.1');
    expect(t.caughtUp()).toBe(false);
    t.current().hello({ replayed: 2 }, 'b.1');
    expect(t.caughtUp()).toBe(false);
    t.current().emit('file.changed', {}, 'b.2');
    t.current().emit('ping', {});
    expect(t.caughtUp()).toBe(false);
    expect(t.deps.retryQueued).not.toHaveBeenCalled();
    t.current().emit('entry.moved', {}, 'b.3');
    expect(t.caughtUp()).toBe(true);
    expect(t.deps.retryQueued).toHaveBeenCalledTimes(1);
    t.stream.stop();
  });

  it('is caught up at once when nothing is replayed', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({ replayed: 0 }, 'b.1');
    expect(t.caughtUp()).toBe(true);
    t.stream.stop();
  });

  it('buffers events during a resync and drops those the tree snapshot already reflects', async () => {
    const t = setup();
    t.stream.start(null);
    t.current().hello({ resync: true, eventId: 'b.2' }, 'b.2');
    expect(t.deps.invalidateAll).toHaveBeenCalled();
    expect(t.stream.isBuffering).toBe(true);
    t.current().emit('file.changed', {}, 'b.3');
    t.current().emit('file.created', {}, 'b.4');
    t.current().emit('file.deleted', {}, 'b.5');
    t.current().emit('file.changed', {}, 'other.1');
    expect(t.applied()).toEqual([]);
    t.tree('b.4');
    await vi.waitFor(() => expect(t.stream.isBuffering).toBe(false));
    expect(t.applied()).toEqual(['file.deleted@b.5', 'file.changed@other.1']);
    expect(t.caughtUp()).toBe(true);
    expect(t.deps.revalidateDocuments).toHaveBeenCalledTimes(1);
    expect(t.stream.lastEventId).toBe('other.1');
    t.stream.stop();
  });

  it('runs the resync procedure on a `resync` event', async () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({}, 'b.1');
    t.current().emit('resync', { reason: 'bulk-change' }, 'b.2');
    expect(t.deps.refetchTree).toHaveBeenCalledTimes(1);
    t.current().emit('file.created', {}, 'b.3');
    t.tree('b.2');
    await vi.waitFor(() => expect(t.applied()).toEqual(['file.created@b.3']));
    t.stream.stop();
  });

  it('reconnects when the page comes back and revalidates documents once replay has caught up', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({}, 'b.1');
    t.current().emit('file.changed', { file: {} }, 'b.2');
    expect(t.deps.revalidateDocuments).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(t.sources).toHaveLength(2);
    expect(t.current().lastEventId).toBe('b.2');
    t.current().hello({ replayed: 1 }, 'b.2');
    expect(t.deps.revalidateDocuments).not.toHaveBeenCalled();
    t.current().emit('file.changed', { file: {} }, 'b.3');
    expect(t.deps.revalidateDocuments).toHaveBeenCalledTimes(1);
    // A later catch-up of the same page (an ordinary reconnect) does not revalidate again.
    t.current().fail(2);
    vi.advanceTimersByTime(RECONNECT_BACKOFF_MS[0]);
    t.current().hello({}, 'b.3');
    expect(t.deps.revalidateDocuments).toHaveBeenCalledTimes(1);
    t.stream.stop();
  });

  it('reconnects on demand (the desktop app after resume) and revalidates documents once caught up', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({}, 'b.1');
    t.current().emit('file.changed', { file: {} }, 'b.2');
    t.stream.reconnect();
    expect(t.sources).toHaveLength(2);
    expect(t.sources[0].closed).toBe(true);
    expect(t.current().lastEventId).toBe('b.2');
    t.current().hello({ replayed: 0 }, 'b.2');
    t.current().emit('file.changed', { file: {} }, 'b.3');
    expect(t.deps.revalidateDocuments).toHaveBeenCalledTimes(1);
    t.stream.stop();
    t.stream.reconnect();
    expect(t.sources).toHaveLength(2);
  });

  it('reports the server build of every hello', () => {
    const t = setup();
    t.stream.start('b.1');
    t.current().hello({ buildSha: 'abc1234' }, 'b.1');
    expect(t.deps.onBuild).toHaveBeenCalledWith('abc1234');
    t.stream.stop();
  });

  it('listens to extension event names, also those registered later', () => {
    const t = setup(['task.created']);
    t.stream.start('b.1');
    t.current().hello({}, 'b.1');
    t.current().emit('task.created', { id: 1 }, 'b.2');
    t.register('task.done');
    t.current().emit('task.done', { id: 1 }, 'b.3');
    expect(t.applied()).toEqual(['task.created@b.2', 'task.done@b.3']);
    t.stream.stop();
  });
});

describe('build check (DESIGN §6.18)', () => {
  afterEach(() => {
    setUnsavedProbe(() => false);
    useUi.setState({ newBuildAvailable: false });
  });

  it('reloads a page whose sessions are all clean', () => {
    const reload = vi.fn();
    setReloader(reload);
    setUnsavedProbe(() => false);
    reportServerBuild('dev', 'dev');
    expect(reload).not.toHaveBeenCalled();
    reportServerBuild('abc1234', 'dev');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useUi.getState().newBuildAvailable).toBe(false);
  });

  it('shows the new-version banner instead when a session is dirty', () => {
    const reload = vi.fn();
    setReloader(reload);
    setUnsavedProbe(() => true);
    reportServerBuild('abc1234', 'dev');
    expect(reload).not.toHaveBeenCalled();
    expect(useUi.getState().newBuildAvailable).toBe(true);
  });
});
