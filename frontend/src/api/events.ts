// EventStream (API.md §16.5, DESIGN §6.3, §6.18): the EventSource lifecycle, `lastEventId`
// tracking, the replay countdown that sets `caughtUp`, resync with buffering, the ping watchdog,
// reconnects after fatal errors, page-visibility recovery, and listeners for the event names
// registered by extensions. What an event *means* for the caches lives in sync/applyEvents.ts.
import type { EventSourceLike } from './endpoints';
import { VAULT_EVENT_NAMES, type HelloEvent } from './types';

/** No event (pings included) for this long means the stream is stale. */
export const STALE_MS = 45_000;
/** Reconnect delays after a fatal error, then every 30 s. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const WATCHDOG_INTERVAL_MS = 5000;
/** A page hidden at least this long reconnects when it becomes visible again. */
const HIDDEN_RECONNECT_MS = 5000;
const RESYNC_RETRY_MS = 3000;

const OPEN = 1;
const CLOSED = 2;

export interface EventStreamDeps {
  clientId: string;
  open(clientId: string, lastEventId: string | null): EventSourceLike;
  /** Applies one event (anything but hello, ping and resync) to the caches. */
  apply(name: string, data: unknown, id: string): void;
  /** Refetches the tree and returns its `eventId`; other server state is invalidated first. */
  refetchTree(): Promise<string>;
  invalidateAll(): void;
  /** Every open document compares its version with the fresh tree. */
  revalidateDocuments(): void;
  /** Queued saves may go now. */
  retryQueued(): void;
  onBuild(buildSha: string): void;
  onHealth(health: 'live' | 'reconnecting'): void;
  onCaughtUp(caughtUp: boolean): void;
  /** Event names registered by extensions (DESIGN §6.8), and a change subscription. */
  extensionNames(): string[];
  onExtensionsChanged(fn: () => void): () => void;
  now?(): number;
}

interface Buffered {
  name: string;
  data: unknown;
  id: string;
}

/** Splits `"<bootId>.<seq>"`; null for anything else. */
export function parseEventId(id: string | null | undefined): { boot: string; seq: number } | null {
  if (!id) return null;
  const dot = id.lastIndexOf('.');
  if (dot <= 0) return null;
  const seq = Number(id.slice(dot + 1));
  return Number.isInteger(seq) ? { boot: id.slice(0, dot), seq } : null;
}

export class EventStream {
  private readonly deps: EventStreamDeps;
  private readonly now: () => number;
  private es: EventSourceLike | null = null;
  private listened = new Set<string>();
  private listeners = new Map<string, (ev: MessageEvent) => void>();
  private last: string | null = null;
  private lastEventAt = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private health: 'live' | 'reconnecting' = 'live';
  private remaining = 0;
  private caughtUp: boolean | null = null;
  private buffering = false;
  private buffer: Buffered[] = [];
  private resyncGeneration = 0;
  private hiddenAt: number | null = null;
  /** The page came back (visible again, or restored from the back/forward cache). */
  private revalidateOnCatchUp = false;
  private cleanups: Array<() => void> = [];
  private stopped = true;

  constructor(deps: EventStreamDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The id the next connection resumes from. */
  get lastEventId(): string | null {
    return this.last;
  }

  get isBuffering(): boolean {
    return this.buffering;
  }

  /** Opens the stream after `GET /api/tree` (its `eventId`, so nothing between is missed). */
  start(lastEventId: string | null): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.last = lastEventId;
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), WATCHDOG_INTERVAL_MS);
    this.cleanups.push(this.deps.onExtensionsChanged(() => this.listenToExtensions()));
    if (typeof document !== 'undefined') {
      const onVisibility = () => this.onVisibility();
      const onPageShow = (e: PageTransitionEvent) => {
        if (!e.persisted) return;
        this.revalidateOnCatchUp = true;
        this.reconnectNow();
      };
      const onOnline = () => {
        if (this.es?.readyState !== OPEN) this.reconnectNow();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('online', onOnline);
      this.cleanups.push(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener('online', onOnline);
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.closeSource();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnectTimer = null;
    this.watchdog = null;
    for (const c of this.cleanups.splice(0)) c();
  }

  /**
   * The desktop app after sleep, resume or a network change (ROADMAP item 41): a fresh connection now,
   * replaying from the last event id, with open documents revalidated once it has caught up (as `pageshow`).
   */
  reconnect(): void {
    if (this.stopped) return;
    this.revalidateOnCatchUp = true;
    this.reconnectNow();
  }

  /** "Reload vault from server" (app.resync): the resync procedure on demand. */
  resyncNow(): Promise<void> {
    return this.resync();
  }

  // ---------- connection ----------

  private connect(): void {
    this.closeSource();
    this.setCaughtUp(false);
    this.lastEventAt = this.now();
    const es = this.deps.open(this.deps.clientId, this.last);
    this.es = es;
    this.listened = new Set();
    this.listeners = new Map();
    for (const name of [...VAULT_EVENT_NAMES, ...this.deps.extensionNames()]) this.listen(name);
    es.onerror = () => this.onError(es);
  }

  private listen(name: string): void {
    if (!this.es || this.listened.has(name)) return;
    const listener = (ev: MessageEvent) => this.onMessage(name, ev);
    this.listened.add(name);
    this.listeners.set(name, listener);
    this.es.addEventListener(name, listener);
  }

  /** Extensions registered later get listeners on the current source (and every future one). */
  private listenToExtensions(): void {
    for (const name of this.deps.extensionNames()) this.listen(name);
  }

  private closeSource(): void {
    const es = this.es;
    if (!es) return;
    for (const [name, listener] of this.listeners) es.removeEventListener(name, listener);
    es.onerror = null;
    es.close();
    this.es = null;
  }

  private onError(es: EventSourceLike): void {
    if (es !== this.es) return;
    this.setHealth('reconnecting');
    this.setCaughtUp(false);
    // A non-200 answer (serve's 502 during a deploy) closes the source for good: recreate it.
    // While CONNECTING, the browser's own `retry: 3000` applies.
    if (es.readyState === CLOSED) {
      this.closeSource();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private checkStale(): void {
    if (this.stopped || !this.es || this.reconnectTimer) return;
    if (this.now() - this.lastEventAt <= STALE_MS) return;
    this.setHealth('reconnecting');
    this.closeSource();
    this.scheduleReconnect();
  }

  private onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = this.now();
      return;
    }
    const hiddenFor = this.hiddenAt === null ? 0 : this.now() - this.hiddenAt;
    this.hiddenAt = null;
    // iOS kills the connection in the background, often without an error: a page that was away
    // for a while reconnects with its last id, and replay fills the gap.
    const stale = this.now() - this.lastEventAt > STALE_MS;
    if (hiddenFor >= HIDDEN_RECONNECT_MS || stale || this.es?.readyState !== OPEN) {
      this.revalidateOnCatchUp = true;
      this.reconnectNow();
    }
  }

  // ---------- messages ----------

  private onMessage(name: string, ev: MessageEvent): void {
    if (this.stopped) return;
    this.lastEventAt = this.now();
    this.setHealth('live');
    const id = ev.lastEventId ?? '';
    if (id) this.last = id;
    let data: unknown;
    try {
      data = typeof ev.data === 'string' && ev.data !== '' ? JSON.parse(ev.data) : null;
    } catch {
      console.warn(`[notesapp] unreadable ${name} event`);
      return;
    }
    if (name === 'ping') return;
    if (name === 'hello') {
      this.onHello(data as HelloEvent);
      return;
    }
    // Replayed events count down to `caughtUp`, buffered or not; a ping never counts.
    if (id && this.remaining > 0) {
      this.remaining--;
      if (this.remaining === 0 && !this.buffering) this.setCaughtUp(true);
    }
    if (name === 'resync') {
      void this.resync();
      return;
    }
    if (this.buffering) {
      this.buffer.push({ name, data, id });
      return;
    }
    this.deliver(name, data, id);
  }

  private onHello(hello: HelloEvent): void {
    this.attempt = 0;
    this.deps.onBuild(hello.buildSha);
    if (hello.resync) {
      this.remaining = 0;
      void this.resync();
      return;
    }
    this.remaining = Math.max(0, hello.replayed);
    if (this.remaining === 0 && !this.buffering) this.setCaughtUp(true);
  }

  private deliver(name: string, data: unknown, id: string): void {
    try {
      this.deps.apply(name, data, id);
    } catch (e) {
      console.error(`[notesapp] applying ${name} failed`, e);
    }
  }

  // ---------- resync (API.md §16.5 step 5) ----------

  private async resync(): Promise<void> {
    const generation = ++this.resyncGeneration;
    this.buffering = true;
    this.setCaughtUp(false);
    this.deps.invalidateAll();
    let treeEventId: string;
    try {
      treeEventId = await this.deps.refetchTree();
    } catch {
      // The server is unreachable; try again while still buffering.
      if (generation === this.resyncGeneration && !this.stopped) {
        setTimeout(() => {
          if (generation === this.resyncGeneration && !this.stopped) void this.resync();
        }, RESYNC_RETRY_MS);
      }
      return;
    }
    if (generation !== this.resyncGeneration || this.stopped) return;
    const snapshot = parseEventId(treeEventId);
    const pending = this.buffer;
    this.buffer = [];
    this.buffering = false;
    for (const e of pending) {
      const id = parseEventId(e.id);
      // The snapshot already reflects events of its boot up to its own id.
      if (snapshot && id && id.boot === snapshot.boot && id.seq <= snapshot.seq) continue;
      this.deliver(e.name, e.data, e.id);
    }
    // The resync revalidates every document itself.
    this.revalidateOnCatchUp = false;
    if (this.remaining === 0) this.setCaughtUp(true);
    this.deps.revalidateDocuments();
  }

  // ---------- status ----------

  private setHealth(health: 'live' | 'reconnecting'): void {
    if (this.health === health) return;
    this.health = health;
    this.deps.onHealth(health);
  }

  private setCaughtUp(caughtUp: boolean): void {
    if (this.caughtUp === caughtUp) return;
    this.caughtUp = caughtUp;
    this.deps.onCaughtUp(caughtUp);
    if (!caughtUp) return;
    // After the page comes back, every open document checks its version against the tree, which
    // the replay (or the resync) has just brought up to date (DESIGN §6.16).
    if (this.revalidateOnCatchUp) {
      this.revalidateOnCatchUp = false;
      this.deps.revalidateDocuments();
    }
    this.deps.retryQueued();
  }

}

