// Statistics (DESIGN §6.34), from the answers of every record and the cards in the notes.
import { State } from 'ts-fsrs';
import type { FlashcardCard } from '../api/types';
import { doneToday, type DoneToday, type StudyItem } from './deck';
import { isNew, reviewsOf, studyDayStart } from './schedule';

const DAY = 86_400_000;
/** A card whose interval reached this many days is mature (Anki's threshold). */
export const MATURE_DAYS = 21;

export interface DayBar {
  /** Start of the study day. */
  day: number;
  count: number;
  again: number;
}

export interface Stats {
  today: DoneToday & { again: number };
  cards: { new: number; learning: number; young: number; mature: number; total: number };
  /** Answers per study day, oldest first, ending today. */
  history: DayBar[];
  /** Cards due per study day, starting today (overdue cards count today). */
  forecast: number[];
  /** Share of review answers that were not "again", over the history window; null without any. */
  retention: { young: number | null; mature: number | null; all: number | null; count: number };
  /** Study days in a row up to today (or yesterday when today is still open). */
  streak: number;
  totalAnswers: number;
  totalMs: number;
}

/** Study-day index of `t` relative to `start` (a study-day start), whole days, DST-safe. */
function dayIndex(t: number, start: number, dayStartsAt: number): number {
  return Math.round((studyDayStart(t, dayStartsAt) - start) / DAY);
}

export function computeStats(
  records: Readonly<Record<string, FlashcardCard>>,
  items: readonly StudyItem[],
  now: number,
  dayStartsAt: number,
  days = 30,
): Stats {
  const todayStart = studyDayStart(now, dayStartsAt);
  const history: DayBar[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - i);
    history.push({ day: d.getTime(), count: 0, again: 0 });
  }
  const studied = new Set<number>();
  let todayAgain = 0;
  let totalAnswers = 0;
  let totalMs = 0;
  const ret = { young: [0, 0], mature: [0, 0] };
  for (const record of Object.values(records)) {
    let prev: number | null = null;
    for (const r of reviewsOf(record)) {
      if (r.rating === 'reset') {
        prev = null;
        continue;
      }
      totalAnswers++;
      totalMs += r.ms ?? 0;
      const idx = dayIndex(r.at, todayStart, dayStartsAt);
      studied.add(idx);
      const bar = history[days - 1 + idx];
      if (bar && idx <= 0) {
        bar.count++;
        if (r.rating === 'again') bar.again++;
      }
      if (idx === 0 && r.rating === 'again') todayAgain++;
      // A review answer: the card was last answered at least a day before (not a learning step).
      if (prev !== null && r.at - prev >= DAY && idx > -days) {
        const bucket = r.at - prev >= MATURE_DAYS * DAY ? ret.mature : ret.young;
        bucket[1]++;
        if (r.rating !== 'again') bucket[0]++;
      }
      prev = r.at;
    }
  }
  const cards = { new: 0, learning: 0, young: 0, mature: 0, total: items.length };
  const forecast = new Array<number>(days).fill(0);
  for (const item of items) {
    const c = item.fsrs;
    if (isNew(c)) {
      cards.new++;
      continue;
    }
    if (c!.state === State.Learning || c!.state === State.Relearning) cards.learning++;
    else if (c!.scheduled_days >= MATURE_DAYS) cards.mature++;
    else cards.young++;
    const idx = Math.max(0, dayIndex(c!.due.getTime(), todayStart, dayStartsAt));
    if (idx < days) forecast[idx]++;
  }
  let streak = 0;
  for (let i = studied.has(0) ? 0 : -1; studied.has(i); i--) streak++;
  const pct = (b: number[]) => (b[1] ? b[0] / b[1] : null);
  return {
    today: { ...doneToday(records, todayStart), again: todayAgain },
    cards,
    history,
    forecast,
    retention: {
      young: pct(ret.young),
      mature: pct(ret.mature),
      all: pct([ret.young[0] + ret.mature[0], ret.young[1] + ret.mature[1]]),
      count: ret.young[1] + ret.mature[1],
    },
    streak,
    totalAnswers,
    totalMs,
  };
}
