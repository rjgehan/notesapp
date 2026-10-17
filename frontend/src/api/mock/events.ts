// Fake SSE for the mock: the same hello/replay/echo-suppression/ping semantics as the server's
// EventHub (API.md §16), delivered to EventSource-like objects instead of a network stream.
import type { EventSourceLike } from '../endpoints';
import type { VaultEventName } from '../types';

interface StoredEvent {
  id: string;
  seq: number;
  name: string;
  data: unknown;
  origin: string | null;
  /** Content events are not delivered to their origin. */
  suppressible: boolean;
}

const RING_SIZE = 1024;
const PING_MS = 20_000;

export class MockEventHub {
  readonly bootId = Math.floor(Date.now() / 1000).toString(36);
  private seq = 0;
  private ring: StoredEvent[] = [];
  private streams = new Set<FakeEventSource>();
  buildSha = 'dev';

  head(): string {
    return `${this.bootId}.${this.seq}`;
  }

  publish(name: VaultEventName | string, data: unknown, origin: string | null, suppressible = true): void {
    const ev: StoredEvent = { id: `${this.bootId}.${++this.seq}`, seq: this.seq, name, data, origin, suppressible };
    this.ring.push(ev);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const s of this.streams) s.deliverStored(ev);
  }

  connect(clientId: string, lastEventId: string | null): FakeEventSource {
    const stream = new FakeEventSource(this, clientId);
    this.streams.add(stream);
    // Open asynchronously, like a real EventSource.
    setTimeout(() => stream.open(lastEventId), 0);
    return stream;
  }

  detach(stream: FakeEventSource): void {
    this.streams.delete(stream);
  }

  /** Simulates a server restart or deploy: every stream errors and closes. */
  dropAll(): void {
    for (const s of [...this.streams]) s.fail();
  }

  replayAfter(lastEventId: string | null): StoredEvent[] | null {
    if (!lastEventId) return null;
    const [boot, seqText] = lastEventId.split('.');
    const seq = Number(seqText);
    if (boot !== this.bootId || !Number.isFinite(seq)) return null;
    if (seq === this.seq) return [];
    const oldest = this.ring[0];
    if (!oldest || seq < oldest.seq - 1) return null;
    return this.ring.filter((e) => e.seq > seq);
  }
}

export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly hub: MockEventHub;
  private readonly clientId: string;

  constructor(hub: MockEventHub, clientId: string) {
    this.hub = hub;
    this.clientId = clientId;
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.hub.detach(this);
  }

  open(lastEventId: string | null): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    const replay = this.hub.replayAfter(lastEventId);
    const resync = replay === null;
    const deliverable = (replay ?? []).filter((e) => !(e.suppressible && e.origin === this.clientId));
    this.emit(
      'hello',
      {
        bootId: this.hub.bootId,
        eventId: this.hub.head(),
        resync,
        replayed: deliverable.length,
        buildSha: this.hub.buildSha,
        serverTime: new Date().toISOString(),
      },
      resync ? this.hub.head() : (lastEventId ?? ''),
    );
    for (const e of deliverable) this.emit(e.name, e.data, e.id);
    this.pingTimer = setInterval(() => this.emit('ping', { serverTime: new Date().toISOString() }, ''), PING_MS);
  }

  deliverStored(e: StoredEvent): void {
    if (this.readyState !== 1) return;
    if (e.suppressible && e.origin === this.clientId) return;
    this.emit(e.name, e.data, e.id);
  }

  fail(): void {
    this.close();
    this.onerror?.(new Event('error'));
  }

  private emit(name: string, data: unknown, id: string): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    const ev = new MessageEvent(name, { data: JSON.stringify(data), lastEventId: id });
    for (const l of [...set]) l(ev);
  }
}
