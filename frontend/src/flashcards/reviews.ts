// Answers as stored (API.md §34.1): `"<instant> <rating>[ <ms>]"`. Kept apart from the scheduler, so
// the main bundle (the outbox, the event handler) does without ts-fsrs, which loads with the page.
import type { FlashcardCard, FlashcardRating } from '../api/types';

export interface Review {
  at: number;
  rating: FlashcardRating;
  ms: number | null;
}

const RATINGS = new Set<string>(['again', 'hard', 'good', 'easy', 'reset']);

/** `"<instant> <rating>[ <ms>]"`, or null. */
export function parseReview(text: string): Review | null {
  const parts = text.trim().split(/ +/);
  if (parts.length < 2 || parts.length > 3 || !RATINGS.has(parts[1])) return null;
  const at = Date.parse(parts[0]);
  if (!Number.isFinite(at)) return null;
  const ms = parts.length === 3 ? Number(parts[2]) : null;
  if (ms !== null && !(Number.isInteger(ms) && ms >= 0)) return null;
  return { at, rating: parts[1] as FlashcardRating, ms };
}

export function formatReview(r: Review): string {
  return `${new Date(r.at).toISOString()} ${r.rating}${r.ms !== null ? ' ' + r.ms : ''}`;
}

/** A record's answers, oldest first, one per instant. */
export function reviewsOf(record: FlashcardCard | undefined): Review[] {
  if (!record) return [];
  const byTime = new Map<number, Review>();
  for (const raw of record.reviews) {
    const r = parseReview(raw);
    if (r && !byTime.has(r.at)) byTime.set(r.at, r);
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

/** True when the record's stored state was computed from exactly its answers. */
export function stateIsCurrent(record: FlashcardCard, reviews: readonly Review[]): boolean {
  const s = record.state;
  if (!s || s.n !== reviews.length) return false;
  const last = reviews.length ? reviews[reviews.length - 1].at : null;
  return (s.lastReview === null ? null : Date.parse(s.lastReview)) === last;
}

