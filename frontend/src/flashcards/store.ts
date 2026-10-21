// Review records on this device (DESIGN §6.34): the server's records (a query kept current by
// `flashcards.changed`) with this device's answers that are not on the server yet laid over them.
// Answers go through an outbox kept in localStorage, so an answer given offline, or on a phone
// that suspended the page, is sent once the server can be reached, in order, and never twice
// (the server unites answers by their time, API.md §34.3).
import type { QueryClient } from '@tanstack/react-query';
import { ApiError, isStorageProblem, isTransient } from '../api/client';
import type { FlashcardCard, FlashcardCardState, FlashcardReview, FlashcardsChangedEvent, FlashcardsResponse, FlashcardWriteResult } from '../api/types';
import { flashcardApi } from './api';
import { formatReview, parseReview, reviewsOf, stateIsCurrent } from './reviews';

export const flashcardKeys = {
  all: ['flashcards'] as const,
  state: ['flashcards', 'state'] as const,
  notes: ['flashcards', 'notes'] as const,
};

export type OutboxOp =
  | { kind: 'review'; review: FlashcardReview }
  | { kind: 'undo'; card: string; at: string; state?: FlashcardCardState };

// ---------- records (pure) ----------

/** `record` with one more answer; the state is kept only when it covers every answer. */
export function withReview(record: FlashcardCard | undefined, review: FlashcardReview, adopted?: FlashcardCard): FlashcardCard {
  const lines = new Map<number, string>();
  for (const source of [adopted, record]) {
    for (const raw of source?.reviews ?? []) {
      const r = parseReview(raw);
      if (r && !lines.has(r.at)) lines.set(r.at, formatReview(r));
    }
  }
  const at = Date.parse(review.at);
  if (!lines.has(at)) lines.set(at, formatReview({ at, rating: review.rating, ms: review.ms ?? null }));
  const reviews = [...lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const next: FlashcardCard = {
    note: review.note ?? record?.note ?? adopted?.note ?? null,
    front: review.front ?? record?.front ?? adopted?.front ?? null,
    state: null,
    reviews,
  };
  return settle(next, [review.state, record?.state]);
}

/** `record` without the answer at `at`; null when none is left. */
export function withoutReview(record: FlashcardCard | undefined, at: string, state?: FlashcardCardState): FlashcardCard | null {
  if (!record) return null;
  const time = Date.parse(at);
  const reviews = record.reviews.filter((raw) => parseReview(raw)?.at !== time);
  if (reviews.length === 0) return null;
  return settle({ ...record, reviews, state: null }, [state, record.state]);
}

/** The first candidate state that covers every answer, else none. */
function settle(record: FlashcardCard, states: Array<FlashcardCardState | null | undefined>): FlashcardCard {
  const reviews = reviewsOf(record);
  for (const s of states) {
    if (s && stateIsCurrent({ ...record, state: s }, reviews)) return { ...record, state: s };
  }
  return { ...record, state: null };
}

/** The server's records with the pending operations applied, in order. */
export function overlay(records: Readonly<Record<string, FlashcardCard>>, ops: readonly OutboxOp[]): Record<string, FlashcardCard> {
  if (ops.length === 0) return records as Record<string, FlashcardCard>;
  const out: Record<string, FlashcardCard> = { ...records };
  for (const op of ops) {
    if (op.kind === 'review') {
      const r = op.review;
      const adopted = r.from && r.from !== r.card ? out[r.from] : undefined;
      if (adopted) delete out[r.from!];
      out[r.card] = withReview(out[r.card], r, adopted);
    } else {
      const next = withoutReview(out[op.card], op.at, op.state);
      if (next) out[op.card] = next;
      else delete out[op.card];
    }
  }
  return out;
}

/** The query data after a write result or an event: changed records replaced, removed ones dropped. */
export function patchRecords(data: FlashcardsResponse, cards: Readonly<Record<string, FlashcardCard | null>>, version?: string): FlashcardsResponse {
  const next = { ...data.cards };
  for (const [id, record] of Object.entries(cards)) {
    if (record) next[id] = record;
    else delete next[id];
  }
  return { ...data, cards: next, version: version ?? data.version };
}

// ---------- outbox ----------

export interface OutboxDeps {
  load(): OutboxOp[];
  save(ops: OutboxOp[]): void;
  sendReviews(reviews: FlashcardReview[]): Promise<FlashcardWriteResult>;
  sendUndo(op: Extract<OutboxOp, { kind: 'undo' }>): Promise<FlashcardWriteResult>;
  onResult(result: FlashcardWriteResult): void;
  /** An operation the server refused (not a transient failure): it is dropped. */
  onRefused(error: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const RETRY_MS = [2000, 4000, 8000, 16_000, 30_000];
const BATCH = 100;

export class Outbox {
  private ops: OutboxOp[];
  private readonly deps: OutboxDeps;
  private inFlight: OutboxOp[] = [];
  private timer: unknown = null;
  private attempt = 0;
  private readonly listeners = new Set<() => void>();
  private snapshotOps: readonly OutboxOp[] = [];

  constructor(deps: OutboxDeps) {
    this.deps = deps;
    this.ops = deps.load();
    this.snapshotOps = [...this.ops];
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Pending operations, in flight included (stable between changes). */
  snapshot = (): readonly OutboxOp[] => this.snapshotOps;

  get size(): number {
    return this.ops.length;
  }

  private changed(): void {
    this.snapshotOps = [...this.ops];
    this.deps.save(this.ops);
    for (const l of this.listeners) l();
  }

  add(op: OutboxOp): void {
    this.ops.push(op);
    this.changed();
    void this.flush();
  }

  /**
   * Takes an answer back. One still waiting here is simply removed; one already sent (or being
   * sent) is undone on the server.
   */
  undo(card: string, at: string, state?: FlashcardCardState): void {
    const i = this.ops.findIndex((op) => op.kind === 'review' && op.review.card === card && op.review.at === at);
    if (i >= 0 && !this.inFlight.includes(this.ops[i])) {
      this.ops.splice(i, 1);
      this.changed();
      return;
    }
    this.add({ kind: 'undo', card, at, state });
  }

  /** Sends what is pending: consecutive answers in one request, undos one by one. */
  async flush(): Promise<void> {
    if (this.inFlight.length || this.ops.length === 0) return;
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
    const first = this.ops[0];
    const batch: OutboxOp[] = [];
    if (first.kind === 'undo') batch.push(first);
    else for (const op of this.ops) {
      if (op.kind !== 'review' || batch.length >= BATCH) break;
      batch.push(op);
    }
    this.inFlight = batch;
    try {
      const result =
        first.kind === 'undo'
          ? await this.deps.sendUndo(first)
          : await this.deps.sendReviews(batch.map((op) => (op as Extract<OutboxOp, { kind: 'review' }>).review));
      this.attempt = 0;
      this.deps.onResult(result);
      this.settleSent(batch);
    } catch (e) {
      if (isTransient(e) || isStorageProblem(e) || !(e instanceof ApiError)) {
        this.inFlight = [];
        this.scheduleRetry();
        return;
      }
      this.settleSent(batch);
      this.deps.onRefused(e);
    }
    if (this.ops.length) void this.flush();
  }

  private settleSent(batch: OutboxOp[]): void {
    this.ops = this.ops.filter((op) => !batch.includes(op));
    this.inFlight = [];
    this.changed();
  }

  private scheduleRetry(): void {
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt++;
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** The connection is back: try at once. */
  retryNow(): void {
    this.attempt = 0;
    void this.flush();
  }
}

// ---------- the app's instance ----------

const STORAGE_KEY = 'notesapp:flashcards:outbox';

function loadOps(): OutboxOp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const ops: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ops) ? (ops as OutboxOp[]).filter((op) => op && (op.kind === 'review' || op.kind === 'undo')) : [];
  } catch {
    return [];
  }
}

function saveOps(ops: OutboxOp[]): void {
  try {
    if (ops.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage full or blocked: the answers stay in memory and are sent while the page lives.
  }
}

let instance: Outbox | null = null;
let client: QueryClient | null = null;
let refusedHandler: (e: unknown) => void = () => {};

/** Patches the state query from a write result (the server's truth for those records). */
export function applyWriteResult(qc: QueryClient, result: FlashcardWriteResult): void {
  qc.setQueryData<FlashcardsResponse>(flashcardKeys.state, (data) => (data ? patchRecords(data, result.cards, result.version) : data));
}

/** `flashcards.changed` from another device. */
export function applyChangedEvent(qc: QueryClient, event: FlashcardsChangedEvent): void {
  if (event.cards === null) {
    void qc.invalidateQueries({ queryKey: flashcardKeys.state });
  } else {
    qc.setQueryData<FlashcardsResponse>(flashcardKeys.state, (data) => (data ? patchRecords(data, event.cards!, event.version) : data));
  }
  if (event.config) {
    const config = event.config;
    qc.setQueryData<FlashcardsResponse>(flashcardKeys.state, (data) => (data ? { ...data, config } : data));
    void qc.invalidateQueries({ queryKey: flashcardKeys.notes });
  }
}

export function installOutbox(qc: QueryClient, onRefused: (e: unknown) => void): Outbox {
  client = qc;
  refusedHandler = onRefused;
  if (!instance) {
    instance = new Outbox({
      load: loadOps,
      save: saveOps,
      sendReviews: (reviews) => flashcardApi.review(reviews),
      sendUndo: (op) => flashcardApi.undo({ card: op.card, at: op.at, state: op.state }),
      onResult: (result) => {
        if (client) applyWriteResult(client, result);
      },
      onRefused: (e) => refusedHandler(e),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
    });
    if (typeof window !== 'undefined') window.addEventListener('online', () => instance?.retryNow());
    if (instance.size) void instance.flush();
  }
  return instance;
}

export function outbox(): Outbox | null {
  return instance;
}
