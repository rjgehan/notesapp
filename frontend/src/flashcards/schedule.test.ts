import { State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { FlashcardCard } from '../api/types';
import { adoptOrphans, bucketOf, deckTree, doneToday, inDeck, limited, orphanRecords, studyItems, type StudyItem } from './deck';
import { parseCards } from './parse';
import {
  cardOf,
  formatInterval,
  formatReview,
  nextStudyDay,
  parseReview,
  preview,
  replay,
  reviewsOf,
  schedulerFor,
  stateIsCurrent,
  studyDayStart,
  toState,
  type Review,
} from './schedule';
import { computeStats } from './stats';
import { CONFIG } from './testing';

const f = schedulerFor(CONFIG);
const T0 = Date.UTC(2026, 9, 1, 9);
const MIN = 60_000;
const DAY = 86_400_000;

function record(reviews: Review[], withState = true): FlashcardCard {
  const card = replay(f, reviews);
  return { note: 'Cards/Note.md', front: 'Q', state: withState && card ? toState(card, reviews.length) : null, reviews: reviews.map(formatReview) };
}

describe('answers', () => {
  it('round-trip their stored form', () => {
    expect(parseReview('2026-10-01T09:00:00.000Z good 5200')).toEqual({ at: T0, rating: 'good', ms: 5200 });
    expect(formatReview({ at: T0, rating: 'again', ms: null })).toBe('2026-10-01T09:00:00.000Z again');
    expect(parseReview('2026-10-01T09:00:00.000Z meh')).toBeNull();
    expect(parseReview('soon good')).toBeNull();
  });

  it('are read sorted and once per instant', () => {
    const r = reviewsOf({ note: null, front: null, state: null, reviews: ['2026-10-02T09:00:00.000Z good', '2026-10-01T09:00:00.000Z again', '2026-10-02T09:00:00.000Z easy'] });
    expect(r.map((x) => x.rating)).toEqual(['again', 'good']);
  });
});

describe('scheduling', () => {
  it('replays answers deterministically, as another device would', () => {
    const reviews: Review[] = [
      { at: T0, rating: 'good', ms: null },
      { at: T0 + 10 * MIN, rating: 'good', ms: null },
      { at: T0 + 3 * DAY, rating: 'hard', ms: null },
    ];
    const a = replay(f, reviews)!;
    const b = replay(schedulerFor({ ...CONFIG }), reviews)!;
    expect(a.due.getTime()).toBe(b.due.getTime());
    expect(a.state).toBe(State.Review);
    expect(a.reps).toBe(3);
  });

  it('uses the stored state while it covers every answer, else replays', () => {
    const reviews: Review[] = [{ at: T0, rating: 'good', ms: null }];
    const rec = record(reviews);
    expect(stateIsCurrent(rec, reviews)).toBe(true);
    const forged = { ...rec, state: { ...rec.state!, due: '2030-01-01T00:00:00.000Z' } };
    expect(cardOf(f, forged)!.due.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    // Another device's answer arrived: the state no longer covers the answers.
    const merged = { ...forged, reviews: [...forged.reviews, formatReview({ at: T0 + 5 * MIN, rating: 'again', ms: null })] };
    expect(cardOf(f, merged)!.due.getTime()).toBe(replay(f, reviewsOf(merged))!.due.getTime());
  });

  it('resets a card to new', () => {
    const card = replay(f, [
      { at: T0, rating: 'good', ms: null },
      { at: T0 + DAY, rating: 'reset', ms: null },
    ]);
    expect(card!.state).toBe(State.New);
  });

  it('previews each answer and formats intervals', () => {
    const p = preview(f, null, T0);
    expect(formatInterval(p.again.interval)).toBe('1m');
    expect(formatInterval(p.good.interval)).toBe('10m');
    expect(p.easy.interval).toBeGreaterThan(DAY);
    expect(formatInterval(30_000)).toBe('<1m');
    expect(formatInterval(3 * 3600_000)).toBe('3h');
    expect(formatInterval(45 * DAY)).toBe('1.5mo');
    expect(formatInterval(400 * DAY)).toBe('1.1y');
  });

  it('starts the study day at the configured hour', () => {
    const late = new Date(2026, 9, 1, 2, 30).getTime();
    expect(new Date(studyDayStart(late, 4)).getDate()).toBe(30);
    const morning = new Date(2026, 9, 1, 9).getTime();
    expect(studyDayStart(morning, 4)).toBe(new Date(2026, 9, 1, 4).getTime());
    expect(nextStudyDay(morning, 4)).toBe(new Date(2026, 9, 2, 4).getTime());
  });
});

function items(text: string, records: Record<string, FlashcardCard>, path = 'Cards/Note.md'): StudyItem[] {
  return studyItems(parseCards(path, text, CONFIG), records, f);
}

describe('decks and counts', () => {
  const text = '#flashcards/lang/es\nhola::hello\nadiós::bye\n\n#flashcards/lang/fr\nbonjour::hello\n\n#flashcards/math\n1+1::2\n';

  it('builds the tree with counts that include sub-decks', () => {
    const cards = parseCards('Cards/Note.md', text, CONFIG);
    const answered = cards.find((c) => c.front === 'hola')!;
    // Answered "good" twice: due in days, so not counted today.
    const rec = record([
      { at: T0, rating: 'good', ms: null },
      { at: T0 + 10 * MIN, rating: 'good', ms: null },
    ]);
    const list = items(text, { [answered.id]: rec });
    const now = T0 + 11 * MIN;
    const tree = deckTree(list, now, now + DAY / 2);
    expect(tree.map((n) => n.name)).toEqual(['flashcards']);
    const root = tree[0];
    expect(root.counts).toEqual({ new: 3, learning: 0, review: 0, total: 4 });
    expect(root.children.map((n) => n.label)).toEqual(['lang', 'math']);
    expect(root.children[0].children.map((n) => [n.label, n.counts.new])).toEqual([
      ['es', 1],
      ['fr', 1],
    ]);
    expect(list.filter((i) => inDeck(i, 'flashcards/lang')).length).toBe(3);
    expect(list.filter((i) => inDeck(i, 'FLASHCARDS/MATH')).length).toBe(1);
  });

  it('buckets cards and caps counts by what today left', () => {
    const reviews: Review[] = [{ at: T0, rating: 'again', ms: null }];
    const learning = { fsrs: replay(f, reviews) };
    expect(bucketOf(learning, T0, T0 + DAY)).toBe('learning');
    expect(bucketOf({ fsrs: null }, T0, T0 + DAY)).toBe('new');
    const review = { fsrs: replay(f, [{ at: T0 - 30 * DAY, rating: 'easy', ms: null }]) };
    expect(bucketOf(review, T0, T0 + DAY)).toBe('review');
    expect(limited({ new: 30, learning: 2, review: 300, total: 400 }, CONFIG, { newCards: 15, reviews: 150 })).toEqual({ new: 5, learning: 2, review: 50, total: 400 });
  });

  it('counts what was done today across records', () => {
    const dayStart = T0 - 2 * 3600_000;
    const records = {
      a: record([{ at: T0, rating: 'good', ms: 3000 }, { at: T0 + MIN, rating: 'good', ms: 2000 }]),
      b: record([{ at: T0 - 3 * DAY, rating: 'good', ms: null }, { at: T0, rating: 'again', ms: 1000 }]),
    };
    expect(doneToday(records, dayStart)).toEqual({ newCards: 1, reviews: 1, answers: 3, ms: 6000 });
  });
});

describe('edited cards', () => {
  it('adopt the record of their old text in the same note, once', () => {
    const before = parseCards('Cards/Note.md', '#flashcards\nWhat is the capital of Frnace?::Paris\n', CONFIG)[0];
    const after = parseCards('Cards/Note.md', '#flashcards\nWhat is the capital of France?::Paris\n', CONFIG)[0];
    const old = { ...record([{ at: T0, rating: 'good', ms: null }]), front: before.hint };
    expect(adoptOrphans([after], { [before.id]: old }).get(after.id)).toBe(before.id);
    const list = studyItems([after], { [before.id]: old }, f);
    expect(list[0].from).toBe(before.id);
    expect(list[0].fsrs).not.toBeNull();
    expect(orphanRecords(list, { [before.id]: old })).toEqual([]);
    // Another note, or a different question: no adoption, and the old record is an orphan.
    expect(adoptOrphans([after], { [before.id]: { ...old, note: 'Other.md' } }).size).toBe(0);
    const unrelated = parseCards('Cards/Note.md', '#flashcards\nLargest planet?::Jupiter\n', CONFIG);
    const list2 = studyItems(unrelated, { [before.id]: old }, f);
    expect(list2[0].from).toBeNull();
    expect(orphanRecords(list2, { [before.id]: old })).toEqual([before.id]);
  });
});

describe('statistics', () => {
  it('summarizes answers, cards, the forecast and the streak', () => {
    const now = new Date(2026, 9, 10, 12).getTime();
    const day = (d: number, h = 9) => new Date(2026, 9, d, h).getTime();
    const recA = record([
      { at: day(8), rating: 'good', ms: 4000 },
      { at: day(9), rating: 'good', ms: 3000 },
      { at: day(10), rating: 'again', ms: 2000 },
    ]);
    const recB = record([{ at: day(10), rating: 'easy', ms: 1000 }]);
    const cards = parseCards('n.md', '#flashcards\nA::1\nB::2\nC::3\n', CONFIG);
    const list = studyItems(cards, { [cards[0].id]: recA, [cards[1].id]: recB }, f);
    const stats = computeStats({ [cards[0].id]: recA, [cards[1].id]: recB }, list, now, 4);
    expect(stats.today.answers).toBe(2);
    expect(stats.today.again).toBe(1);
    expect(stats.today.newCards).toBe(1);
    expect(stats.cards.new).toBe(1);
    expect(stats.cards.total).toBe(3);
    expect(stats.history.at(-1)).toMatchObject({ count: 2, again: 1 });
    expect(stats.history.at(-2)).toMatchObject({ count: 1 });
    expect(stats.streak).toBe(3);
    expect(stats.retention.count).toBe(2);
    expect(stats.retention.young).toBe(0.5);
    expect(stats.forecast.reduce((a, b) => a + b, 0)).toBe(2);
    expect(stats.totalMs).toBe(10_000);
  });
});
