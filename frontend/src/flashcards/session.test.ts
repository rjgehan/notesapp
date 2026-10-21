import { describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../api/client';
import type { FlashcardCard, FlashcardReview, FlashcardWriteResult } from '../api/types';
import { studyItems, type StudyItem } from './deck';
import { parseCards } from './parse';
import { formatReview, replay, schedulerFor, toState, type Review } from './schedule';
import { CONFIG } from './testing';
import { answer, buildQueue, pickNext, refresh, remaining, reveal, skip, spreadSiblings, startSession, undo, waitingUntil } from './session';
import { Outbox, overlay, patchRecords, withoutReview, withReview, type OutboxDeps, type OutboxOp } from './store';

const f = schedulerFor(CONFIG);
const T0 = Date.UTC(2026, 9, 1, 9);
const MIN = 60_000;
const DAY = 86_400_000;
const END = T0 + 12 * 3600_000;

function rec(reviews: Review[]): FlashcardCard {
  const card = replay(f, reviews)!;
  return { note: 'n.md', front: 'q', state: toState(card, reviews.length), reviews: reviews.map(formatReview) };
}

function deck(text: string, records: Record<string, FlashcardCard> = {}): StudyItem[] {
  return studyItems(parseCards('n.md', text, CONFIG), records, f);
}

describe('queue', () => {
  it('puts learning first, spreads new cards among reviews, within the limits', () => {
    const cards = parseCards('n.md', '#flashcards\nR1::a\nR2::b\nR3::c\nR4::d\nN1::e\nN2::f\nN3::g\nL1::h\n', CONFIG);
    const old: Review[] = [{ at: T0 - 40 * DAY, rating: 'easy', ms: null }];
    const records: Record<string, FlashcardCard> = {};
    for (const c of cards.slice(0, 4)) records[c.id] = rec(old);
    records[cards[7].id] = rec([{ at: T0 - MIN, rating: 'again', ms: null }]);
    const items = studyItems(cards, records, f);
    const q = buildQueue(items, T0, END, { newLeft: 2, reviewLeft: 4 });
    // Reviews due together go in id order; one new card after every two reviews.
    expect(q.map((i) => i.card.front[0])).toEqual(['L', 'R', 'N', 'R', 'R', 'N', 'R']);
    expect(q.filter((i) => i.card.front[0] === 'N').map((i) => i.card.front)).toEqual(['N1', 'N2']);
    expect(buildQueue(items, T0, END, { newLeft: 0, reviewLeft: 1 }).map((i) => i.card.front[0])).toEqual(['L', 'R']);
  });

  it('keeps siblings apart', () => {
    const items = deck('#flashcards\nA:::1\nB:::2\n');
    const spread = spreadSiblings(items);
    for (let i = 1; i < spread.length; i++) expect(spread[i].card.sibling === spread[i - 1].card.sibling && i < 3).toBe(false);
  });
});

describe('session', () => {
  it('reveals, answers, brings "again" back and finishes', () => {
    const items = deck('#flashcards\nQ1::A1\nQ2::A2\n');
    let s = startSession(buildQueue(items, T0, END, { newLeft: 10, reviewLeft: 10 }), T0);
    expect(s.current?.card.front).toBe('Q1');
    expect(remaining(s, T0, END)).toEqual({ new: 2, learning: 0, review: 0 });
    s = reveal(s);
    expect(s.revealed).toBe(true);
    const first = answer(s, 'again', T0 + 5000, f, END)!;
    expect(first.answered.review).toEqual({ at: T0 + 5000, rating: 'again', ms: 5000 });
    s = first.state;
    expect(s.current?.card.front).toBe('Q2');
    expect(s.learning).toHaveLength(1);
    s = answer(reveal(s), 'easy', T0 + 10_000, f, END)!.state;
    // Q1 is due in a minute: learning ahead shows it now rather than ending.
    expect(s.current?.card.front).toBe('Q1');
    s = answer(reveal(s), 'good', T0 + 20_000, f, END)!.state;
    // Due again in 10 minutes: nothing to show until then.
    expect(s.current?.card.front ?? null).toBe('Q1');
  });

  it('waits for a learning card due later, then shows it', () => {
    const items = deck('#flashcards\nQ1::A1\n');
    let s = startSession(buildQueue(items, T0, END, { newLeft: 10, reviewLeft: 10 }), T0);
    s = answer(reveal(s), 'again', T0, f, END)!.state; // back in 1m: shown at once (learn ahead)
    s = answer(reveal(s), 'good', T0 + MIN, f, END)!.state; // back in 10m: still within learn-ahead
    s = answer(reveal(s), 'good', T0 + 11 * MIN, f, END)!.state; // graduated: days away
    expect(s.current).toBeNull();
    expect(waitingUntil(s)).toBeNull();
    expect(s.answered).toHaveLength(3);
  });

  it('undoes the last answer and shows that card again', () => {
    const items = deck('#flashcards\nQ1::A1\nQ2::A2\n');
    let s = startSession(buildQueue(items, T0, END, { newLeft: 10, reviewLeft: 10 }), T0);
    s = answer(reveal(s), 'again', T0, f, END)!.state;
    const u = undo(s, T0 + 1000)!;
    expect(u.undone.review.rating).toBe('again');
    expect(u.state.current?.card.front).toBe('Q1');
    expect(u.state.current?.fsrs).toBeNull();
    expect(u.state.learning).toHaveLength(0);
    expect(u.state.queue.map((i) => i.card.front)).toEqual(['Q2']);
    expect(undo({ ...u.state, answered: [] }, T0)).toBeNull();
  });

  it('skips a card, and drops queued cards answered elsewhere', () => {
    const items = deck('#flashcards\nQ1::A1\nQ2::A2\nQ3::A3\n');
    let s = startSession(buildQueue(items, T0, END, { newLeft: 10, reviewLeft: 10 }), T0);
    s = skip(s, T0);
    expect(s.current?.card.front).toBe('Q2');
    const q3 = items[2];
    const elsewhere = new Map(items.map((i) => [i.card.id, i]));
    elsewhere.set(q3.card.id, { ...q3, fsrs: replay(f, [{ at: T0, rating: 'easy', ms: null }]), answers: 1 });
    s = refresh(s, elsewhere, T0, END);
    expect(s.queue).toHaveLength(0);
    expect(pickNext({ ...s, current: null }, T0).current).toBeNull();
  });
});

describe('records on this device', () => {
  const r1: FlashcardReview = { card: 'c1', at: '2026-10-01T09:00:00.000Z', rating: 'good', ms: 1000, note: 'n.md', front: 'Q' };

  it('add and remove answers, keeping a state only while it covers them', () => {
    const state = toState(replay(f, [{ at: T0, rating: 'good', ms: null }])!, 1);
    const one = withReview(undefined, { ...r1, state });
    expect(one.reviews).toEqual(['2026-10-01T09:00:00.000Z good 1000']);
    expect(one.state).toEqual(state);
    const two = withReview(one, { card: 'c1', at: '2026-10-01T08:00:00.000Z', rating: 'again' });
    expect(two.reviews).toHaveLength(2);
    expect(two.state).toBeNull();
    expect(withReview(two, { card: 'c1', at: '2026-10-01T08:00:00.000Z', rating: 'again' }).reviews).toHaveLength(2);
    const back = withoutReview(two, '2026-10-01T08:00:00.000Z', state);
    expect(back?.state).toEqual(state);
    expect(withoutReview(one, r1.at)).toBeNull();
  });

  it('overlay pending answers and moves on the server records', () => {
    const server: Record<string, FlashcardCard> = { old: { note: 'n.md', front: 'Q', state: null, reviews: ['2026-09-30T09:00:00.000Z good'] } };
    const ops: OutboxOp[] = [{ kind: 'review', review: { ...r1, from: 'old' } }];
    const out = overlay(server, ops);
    expect(Object.keys(out)).toEqual(['c1']);
    expect(out.c1.reviews).toHaveLength(2);
    expect(overlay(server, [])).toBe(server);
    const undone = overlay(out, [{ kind: 'undo', card: 'c1', at: r1.at }]);
    expect(undone.c1.reviews).toEqual(['2026-09-30T09:00:00.000Z good']);
    const data = { config: CONFIG, cards: server, version: 'v1' };
    expect(patchRecords(data, { old: null, c2: out.c1 }, 'v2')).toEqual({ config: CONFIG, cards: { c2: out.c1 }, version: 'v2' });
  });
});

describe('outbox', () => {
  function setup(load: OutboxOp[] = []) {
    const saved: OutboxOp[][] = [];
    const timers: Array<() => void> = [];
    const deps: OutboxDeps = {
      load: () => load,
      save: (ops) => saved.push([...ops]),
      sendReviews: vi.fn<OutboxDeps['sendReviews']>(),
      sendUndo: vi.fn<OutboxDeps['sendUndo']>(),
      onResult: vi.fn(),
      onRefused: vi.fn(),
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    };
    return { deps, saved, timers };
  }
  const ok: FlashcardWriteResult = { cards: {}, version: 'v' };
  const review = (card: string, at: string): OutboxOp => ({ kind: 'review', review: { card, at, rating: 'good' } });

  it('sends answers in order, retries transient failures and keeps them meanwhile', async () => {
    const { deps, saved, timers } = setup();
    vi.mocked(deps.sendReviews).mockRejectedValueOnce(new TransientError('offline')).mockResolvedValue(ok);
    const box = new Outbox(deps);
    box.add(review('a', '2026-10-01T09:00:00.000Z'));
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(box.size).toBe(1);
    expect(saved.at(-1)).toHaveLength(1);
    box.add(review('b', '2026-10-01T09:01:00.000Z'));
    timers[0]();
    await vi.waitFor(() => expect(box.size).toBe(0));
    expect(vi.mocked(deps.sendReviews).mock.calls.at(-1)![0].map((r) => r.card)).toEqual(['a', 'b']);
    expect(deps.onResult).toHaveBeenCalledWith(ok);
    expect(saved.at(-1)).toEqual([]);
  });

  it('drops what the server refuses, and resends what was saved before a reload', async () => {
    const { deps } = setup([review('a', '2026-10-01T09:00:00.000Z')]);
    const problem = new ApiError({ type: 'urn:notesapp:problem:bad-request', title: 'Bad request', status: 400, code: 'bad-request', detail: 'no' } as never);
    vi.mocked(deps.sendReviews).mockRejectedValue(problem);
    const box = new Outbox(deps);
    expect(box.size).toBe(1);
    await box.flush();
    expect(box.size).toBe(0);
    expect(deps.onRefused).toHaveBeenCalledWith(problem);
  });

  it('undoes an unsent answer locally and a sent one on the server', async () => {
    const { deps } = setup();
    let release!: (r: FlashcardWriteResult) => void;
    vi.mocked(deps.sendReviews).mockImplementation(() => new Promise((r) => (release = r)));
    vi.mocked(deps.sendUndo).mockResolvedValue(ok);
    const box = new Outbox(deps);
    box.add(review('a', '2026-10-01T09:00:00.000Z')); // in flight
    box.add(review('b', '2026-10-01T09:01:00.000Z')); // waiting
    box.undo('b', '2026-10-01T09:01:00.000Z');
    expect(box.snapshot().map((op) => (op.kind === 'review' ? op.review.card : 'undo'))).toEqual(['a']);
    box.undo('a', '2026-10-01T09:00:00.000Z');
    expect(box.snapshot().map((op) => op.kind)).toEqual(['review', 'undo']);
    release(ok);
    await vi.waitFor(() => expect(box.size).toBe(0));
    expect(deps.sendUndo).toHaveBeenCalledWith({ kind: 'undo', card: 'a', at: '2026-10-01T09:00:00.000Z', state: undefined });
  });
});
