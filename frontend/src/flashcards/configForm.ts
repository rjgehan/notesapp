// The flashcard settings form (API.md §34.5): text fields to a config, and the changed fields.
import type { FlashcardConfig } from '../api/types';

export interface Draft {
  tags: string;
  foldersAsDecks: boolean;
  newPerDay: string;
  reviewsPerDay: string;
  retention: string;
  maximumInterval: string;
  learningSteps: string;
  relearningSteps: string;
  fuzz: boolean;
  dayStartsAt: string;
}

export function draftOf(c: FlashcardConfig): Draft {
  return {
    tags: c.tags.map((t) => '#' + t).join(' '),
    foldersAsDecks: c.foldersAsDecks,
    newPerDay: String(c.newPerDay),
    reviewsPerDay: String(c.reviewsPerDay),
    retention: String(Math.round(c.retention * 100)),
    maximumInterval: String(c.maximumInterval),
    learningSteps: c.learningSteps.join(' '),
    relearningSteps: c.relearningSteps.join(' '),
    fuzz: c.fuzz,
    dayStartsAt: String(c.dayStartsAt),
  };
}

const STEP = /^\d{1,5}(\.\d{1,3})?[mhd]$/;

/** The config the draft describes, or the first problem with it. */
export function configOf(d: Draft): FlashcardConfig | string {
  const tags = d.tags
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);
  if (tags.length === 0) return 'Name at least one tag.';
  const int = (s: string, min: number, max: number, what: string): number | string => {
    const n = Number(s);
    return Number.isInteger(n) && n >= min && n <= max ? n : `${what} must be a whole number from ${min} to ${max}.`;
  };
  const steps = (s: string): string[] | null => {
    const list = s.split(/[\s,]+/).filter(Boolean);
    return list.length <= 10 && list.every((x) => STEP.test(x)) ? list : null;
  };
  const newPerDay = int(d.newPerDay, 0, 9999, 'New cards a day');
  if (typeof newPerDay === 'string') return newPerDay;
  const reviewsPerDay = int(d.reviewsPerDay, 0, 99999, 'Reviews a day');
  if (typeof reviewsPerDay === 'string') return reviewsPerDay;
  const retention = int(d.retention, 70, 99, 'Desired retention');
  if (typeof retention === 'string') return retention;
  const maximumInterval = int(d.maximumInterval, 1, 36500, 'Maximum interval');
  if (typeof maximumInterval === 'string') return maximumInterval;
  const dayStartsAt = int(d.dayStartsAt, 0, 23, 'The hour a day starts');
  if (typeof dayStartsAt === 'string') return dayStartsAt;
  const learningSteps = steps(d.learningSteps);
  const relearningSteps = steps(d.relearningSteps);
  if (!learningSteps || !relearningSteps) return 'Steps are times such as 1m 10m or 1d, up to 10.';
  return { tags, foldersAsDecks: d.foldersAsDecks, newPerDay, reviewsPerDay, retention: retention / 100, maximumInterval, learningSteps, relearningSteps, fuzz: d.fuzz, dayStartsAt };
}

/** The fields of `next` that differ from `base`. */
export function changedFields(base: FlashcardConfig, next: FlashcardConfig): Partial<FlashcardConfig> {
  const out: Partial<FlashcardConfig> = {};
  for (const key of Object.keys(next) as (keyof FlashcardConfig)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(base[key])) (out as Record<string, unknown>)[key] = next[key];
  }
  return out;
}

