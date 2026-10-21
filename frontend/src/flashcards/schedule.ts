// FSRS scheduling with ts-fsrs (DESIGN §6.34). A card's answers are the truth: its FSRS state is
// what replaying them gives. The server keeps the state the answering device computed as a cache
// (API.md §34.1), valid while it covers every answer; when two devices answered the same card at
// once, or an answer was undone, the state is recomputed here by replaying the answers in order.
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type FSRS, type Grade, type StepUnit } from 'ts-fsrs';
import type { FlashcardCard, FlashcardCardState, FlashcardConfig, FlashcardPhase, FlashcardRating } from '../api/types';
import { reviewsOf, stateIsCurrent, type Review } from './reviews';

export { formatReview, parseReview, reviewsOf, stateIsCurrent, type Review } from './reviews';

export type Answer = Exclude<FlashcardRating, 'reset'>;

export const GRADES: Record<Answer, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
export const ANSWERS: readonly Answer[] = ['again', 'hard', 'good', 'easy'];

const schedulers = new Map<string, FSRS>();

/** The scheduler for these settings (cached). */
export function schedulerFor(config: Pick<FlashcardConfig, 'retention' | 'maximumInterval' | 'learningSteps' | 'relearningSteps' | 'fuzz'>): FSRS {
  const key = JSON.stringify([config.retention, config.maximumInterval, config.learningSteps, config.relearningSteps, config.fuzz]);
  let f = schedulers.get(key);
  if (!f) {
    f = fsrs(
      generatorParameters({
        request_retention: config.retention,
        maximum_interval: config.maximumInterval,
        enable_fuzz: config.fuzz,
        enable_short_term: true,
        learning_steps: config.learningSteps as StepUnit[],
        relearning_steps: config.relearningSteps as StepUnit[],
      }),
    );
    schedulers.set(key, f);
  }
  return f;
}

const PHASES: Record<State, FlashcardPhase> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};
const STATES: Record<FlashcardPhase, State> = { new: State.New, learning: State.Learning, review: State.Review, relearning: State.Relearning };

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** The state to store for `card` after `n` answers (numbers rounded, so the file stays readable). */
export function toState(card: Card, n: number): FlashcardCardState {
  return {
    due: card.due.toISOString(),
    stability: round4(card.stability),
    difficulty: round4(card.difficulty),
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    phase: PHASES[card.state],
    lastReview: card.last_review ? card.last_review.toISOString() : null,
    n,
  };
}

export function fromState(s: FlashcardCardState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: 0,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: STATES[s.phase],
    last_review: s.lastReview ? new Date(s.lastReview) : undefined,
  };
}

/** Applies one answer (or a reset) to a card; `null` is a new card. */
export function step(f: FSRS, card: Card | null, review: Review): Card {
  const when = new Date(review.at);
  if (review.rating === 'reset') return createEmptyCard(when);
  return f.next(card ?? createEmptyCard(when), when, GRADES[review.rating]).card;
}

/** The card after all `reviews`, or null for a card never answered. */
export function replay(f: FSRS, reviews: readonly Review[]): Card | null {
  let card: Card | null = null;
  for (const r of reviews) card = step(f, card, r);
  return card;
}

const cache = new WeakMap<FlashcardCard, { key: string; card: Card | null }>();

/** The FSRS card of a record: its stored state when current, else the replay (cached per record). */
export function cardOf(f: FSRS, record: FlashcardCard | undefined): Card | null {
  if (!record || record.reviews.length === 0) return null;
  const key = JSON.stringify([f.parameters.request_retention, f.parameters.maximum_interval, f.parameters.learning_steps, f.parameters.relearning_steps, f.parameters.enable_fuzz]);
  const hit = cache.get(record);
  if (hit && hit.key === key) return hit.card;
  const reviews = reviewsOf(record);
  const card = stateIsCurrent(record, reviews) ? fromState(record.state!) : replay(f, reviews);
  cache.set(record, { key, card });
  return card;
}

/** Whether a card counts as new: never answered, or reset. */
export function isNew(card: Card | null): boolean {
  return card === null || card.state === State.New;
}

/** The start of the study day that `now` falls in (local time, starting at `dayStartsAt` o'clock). */
export function studyDayStart(now: number, dayStartsAt: number): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), dayStartsAt);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  return start.getTime();
}

/** The start of the next study day. */
export function nextStudyDay(now: number, dayStartsAt: number): number {
  const start = new Date(studyDayStart(now, dayStartsAt));
  start.setDate(start.getDate() + 1);
  return start.getTime();
}

/** "1m", "10m", "3h", "4d", "2.5mo", "1.2y": the interval a button would schedule. */
export function formatInterval(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30).toFixed(d < 300 ? 1 : 0).replace(/\.0$/, '')}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

/** What each answer would do to `card` now: the next card and its interval. */
export function preview(f: FSRS, card: Card | null, now: number): Record<Answer, { card: Card; interval: number }> {
  const out = {} as Record<Answer, { card: Card; interval: number }>;
  for (const a of ANSWERS) {
    const next = step(f, card, { at: now, rating: a, ms: null });
    out[a] = { card: next, interval: next.due.getTime() - now };
  }
  return out;
}
