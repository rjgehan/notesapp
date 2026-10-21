// A review session (DESIGN §6.34), as pure state transitions: the queue of today's cards, the
// card shown, the cards answered "again" that come back later in the session, and undo.
import type { Card, FSRS } from 'ts-fsrs';
import { State } from 'ts-fsrs';
import { bucketOf, LEARN_AHEAD_MS, type StudyItem } from './deck';
import type { FlashcardReview } from '../api/types';
import { step, toState, type Answer, type Review } from './schedule';

/** Answer times are capped at this (Anki's default): a card left open is not a minute of study. */
export const MAX_ANSWER_MS = 60_000;

export interface Answered {
  item: StudyItem;
  review: Review;
  after: Card;
}

export interface SessionState {
  /** Cards not shown yet, in order. */
  queue: StudyItem[];
  /** Answered cards that come back today, earliest first. */
  learning: { item: StudyItem; due: number }[];
  current: StudyItem | null;
  revealed: boolean;
  /** When the current card was shown. */
  shownAt: number;
  answered: Answered[];
}

export interface Limits {
  newLeft: number;
  reviewLeft: number;
}

/** Moves cards so that two cards from the same text are not shown one after the other. */
export function spreadSiblings(list: StudyItem[]): StudyItem[] {
  const out = [...list];
  for (let i = 1; i < out.length; i++) {
    if (out[i].card.sibling !== out[i - 1].card.sibling || out[i].card.path !== out[i - 1].card.path) continue;
    const j = out.findIndex((x, k) => k > i && (x.card.sibling !== out[i - 1].card.sibling || x.card.path !== out[i - 1].card.path));
    if (j < 0) break;
    const [moved] = out.splice(j, 1);
    out.splice(i, 0, moved);
  }
  return out;
}

/**
 * Today's queue: learning cards due now, then reviews (most overdue first) with new cards (in note
 * order) spread evenly among them, both within the daily limits.
 */
export function buildQueue(items: readonly StudyItem[], now: number, dayEnd: number, limits: Limits): StudyItem[] {
  const learning: StudyItem[] = [];
  const reviews: StudyItem[] = [];
  const fresh: StudyItem[] = [];
  for (const item of items) {
    const b = bucketOf(item, now, dayEnd);
    if (b === 'learning') learning.push(item);
    else if (b === 'review') reviews.push(item);
    else if (b === 'new') fresh.push(item);
  }
  const due = (x: StudyItem) => x.fsrs?.due.getTime() ?? 0;
  learning.sort((a, b) => due(a) - due(b));
  reviews.sort((a, b) => due(a) - due(b) || a.card.id.localeCompare(b.card.id));
  fresh.sort((a, b) => a.card.path.localeCompare(b.card.path) || a.card.line - b.card.line);
  const r = reviews.slice(0, Math.max(0, limits.reviewLeft));
  const n = fresh.slice(0, Math.max(0, limits.newLeft));
  const mixed: StudyItem[] = [];
  if (n.length === 0) mixed.push(...r);
  else {
    // One new card after every `gap` reviews.
    const gap = r.length / (n.length + 1);
    let ri = 0;
    for (let ni = 0; ni < n.length; ni++) {
      const until = Math.round(gap * (ni + 1));
      while (ri < until) mixed.push(r[ri++]);
      mixed.push(n[ni]);
    }
    while (ri < r.length) mixed.push(r[ri++]);
  }
  return [...learning, ...spreadSiblings(mixed)];
}

export function startSession(queue: StudyItem[], now: number): SessionState {
  return pickNext({ queue, learning: [], current: null, revealed: false, shownAt: now, answered: [] }, now);
}

/** Shows the next card: a learning card that is due, else the queue, else learning ahead. */
export function pickNext(s: SessionState, now: number): SessionState {
  const lastSibling = s.answered.length ? s.answered[s.answered.length - 1].item.card : null;
  const learning = [...s.learning];
  let queue = s.queue;
  let current: StudyItem | null = null;
  if (learning.length && learning[0].due <= now) current = learning.shift()!.item;
  else if (queue.length) {
    let index = 0;
    // Not a sibling of the card just answered, when another card can come first.
    if (lastSibling) {
      const other = queue.findIndex((x) => x.card.sibling !== lastSibling.sibling || x.card.path !== lastSibling.path);
      if (other > 0) index = other;
    }
    current = queue[index];
    queue = [...queue.slice(0, index), ...queue.slice(index + 1)];
  } else if (learning.length && learning[0].due <= now + LEARN_AHEAD_MS) current = learning.shift()!.item;
  return { ...s, queue, learning, current, revealed: false, shownAt: now };
}

export function reveal(s: SessionState): SessionState {
  return s.current && !s.revealed ? { ...s, revealed: true } : s;
}

/** Answers the current card; a card still learning comes back today. */
export function answer(s: SessionState, rating: Answer, now: number, f: FSRS, dayEnd: number): { state: SessionState; answered: Answered } | null {
  const item = s.current;
  if (!item) return null;
  const review: Review = { at: now, rating, ms: Math.min(MAX_ANSWER_MS, Math.max(0, now - s.shownAt)) };
  const after = step(f, item.fsrs, review);
  const answered: Answered = { item, review, after };
  const learning = [...s.learning];
  const due = after.due.getTime();
  if ((after.state === State.Learning || after.state === State.Relearning) && due < dayEnd) {
    learning.push({ item: { ...item, fsrs: after, answers: item.answers + 1 }, due });
    learning.sort((a, b) => a.due - b.due);
  }
  const next = pickNext({ ...s, learning, answered: [...s.answered, answered], current: null }, now);
  return { state: next, answered };
}

/** Takes the last answer back: its card is shown again as it was. */
export function undo(s: SessionState, now: number): { state: SessionState; undone: Answered } | null {
  const undone = s.answered[s.answered.length - 1];
  if (!undone) return null;
  const id = undone.item.card.id;
  const learning = s.learning.filter((x) => x.item.card.id !== id);
  const queue = s.current && s.current.card.id !== id ? [s.current, ...s.queue] : s.queue;
  return {
    state: { queue, learning, current: undone.item, revealed: false, shownAt: now, answered: s.answered.slice(0, -1) },
    undone,
  };
}

/** Skips the current card for this session. */
export function skip(s: SessionState, now: number): SessionState {
  return pickNext({ ...s, current: null }, now);
}

/** When the next card comes back, when nothing is shown and a learning card waits. */
export function waitingUntil(s: SessionState): number | null {
  return !s.current && s.learning.length ? s.learning[0].due : null;
}

/** Cards left: shown now included, learning cards counted once. */
export function remaining(s: SessionState, now: number, dayEnd: number): { new: number; learning: number; review: number } {
  const out = { new: 0, learning: s.learning.length, review: 0 };
  for (const item of s.current ? [s.current, ...s.queue] : s.queue) {
    if (s.learning.some((x) => x.item.card.id === item.card.id)) continue;
    const b = bucketOf(item, now, dayEnd);
    if (b === 'new') out.new++;
    else if (b === 'learning') out.learning++;
    else out.review++;
  }
  return out;
}

/**
 * Takes in what changed elsewhere (an answer on another device, an edited note): queued cards get
 * their current record, and cards no longer due or no longer in a note leave the queue. The card
 * shown stays, so the screen never changes under the user's thumb.
 */
export function refresh(s: SessionState, items: ReadonlyMap<string, StudyItem>, now: number, dayEnd: number): SessionState {
  const answeredIds = new Set(s.answered.map((a) => a.item.card.id));
  const queue: StudyItem[] = [];
  for (const old of s.queue) {
    const fresh = items.get(old.card.id);
    if (!fresh) continue;
    if (!answeredIds.has(fresh.card.id) && bucketOf(fresh, now, dayEnd) === 'later') continue;
    queue.push(fresh);
  }
  const changed = queue.length !== s.queue.length || queue.some((x, i) => x !== s.queue[i]);
  return changed ? { ...s, queue } : s;
}

/** The answer as sent to the server (API.md §34.3), with the state it leads to. */
export function toReview(a: Answered): FlashcardReview {
  const { item, review, after } = a;
  const out: FlashcardReview = {
    card: item.card.id,
    at: new Date(review.at).toISOString(),
    rating: review.rating,
    note: item.card.path,
    front: item.card.hint,
    state: toState(after, item.answers + 1),
  };
  if (review.ms !== null) out.ms = review.ms;
  if (item.from) out.from = item.from;
  return out;
}
