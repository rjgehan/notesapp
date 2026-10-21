// Cards with their records, decks and due counts (DESIGN §6.34).
import type { Card, FSRS } from 'ts-fsrs';
import { State } from 'ts-fsrs';
import type { FlashcardCard, FlashcardConfig } from '../api/types';
import { similarity } from './ids';
import type { ParsedCard } from './parse';
import { cardOf, isNew, nextStudyDay, reviewsOf, studyDayStart } from './schedule';

/** A learning card due within this long counts as due now (Anki's "learn ahead"). */
export const LEARN_AHEAD_MS = 20 * 60_000;

/** A record whose card text changed this little is the same card (its id changed). */
export const ADOPT_SIMILARITY = 0.75;

export interface StudyItem {
  card: ParsedCard;
  /** The record this card's answers are in: its own, or an adopted one (`from`). */
  record: FlashcardCard | undefined;
  /** The id of the record adopted from an edited version of this card. */
  from: string | null;
  /** The FSRS card; null when never answered. */
  fsrs: Card | null;
  /** How many answers `fsrs` covers (the `n` of the state stored with the next answer). */
  answers: number;
}

export type Bucket = 'new' | 'learning' | 'review' | 'later';

/**
 * Records of cards that are gone, matched to new cards with no record in the same note whose
 * question is close (an edited typo): card id → orphan id. Each orphan goes to at most one card.
 */
export function adoptOrphans(cards: readonly ParsedCard[], records: Readonly<Record<string, FlashcardCard>>): Map<string, string> {
  const ids = new Set(cards.map((c) => c.id));
  const orphans = Object.entries(records).filter(([id, r]) => !ids.has(id) && r.note !== null && r.front !== null && r.reviews.length > 0);
  const out = new Map<string, string>();
  if (orphans.length === 0) return out;
  const candidates: { card: string; orphan: string; score: number }[] = [];
  for (const card of cards) {
    if (records[card.id]) continue;
    for (const [id, r] of orphans) {
      if (r.note !== card.path) continue;
      const score = similarity(r.front!, card.hint);
      if (score >= ADOPT_SIMILARITY) candidates.push({ card: card.id, orphan: id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const taken = new Set<string>();
  for (const c of candidates) {
    if (out.has(c.card) || taken.has(c.orphan)) continue;
    out.set(c.card, c.orphan);
    taken.add(c.orphan);
  }
  return out;
}

/** Every card once (the first by path and line when the same card is written twice), with its record. */
export function studyItems(cards: readonly ParsedCard[], records: Readonly<Record<string, FlashcardCard>>, f: FSRS): StudyItem[] {
  const adopted = adoptOrphans(cards, records);
  const seen = new Set<string>();
  const items: StudyItem[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const from = records[card.id] ? null : (adopted.get(card.id) ?? null);
    const record = records[card.id] ?? (from ? records[from] : undefined);
    items.push({ card, record, from, fsrs: cardOf(f, record), answers: reviewsOf(record).length });
  }
  return items;
}

/** Where a card stands now. */
export function bucketOf(item: Pick<StudyItem, 'fsrs'>, now: number, dayEnd: number): Bucket {
  const c = item.fsrs;
  if (isNew(c)) return 'new';
  const due = c!.due.getTime();
  if (c!.state === State.Learning || c!.state === State.Relearning) return due <= now + LEARN_AHEAD_MS ? 'learning' : 'later';
  return due < dayEnd ? 'review' : 'later';
}

export interface DoneToday {
  /** Cards answered for the first time today. */
  newCards: number;
  /** Answers today to cards that were not new today. */
  reviews: number;
  /** Every answer today. */
  answers: number;
  /** Time spent answering today. */
  ms: number;
}

/** What was studied since `dayStart`, across every record (so on every device). */
export function doneToday(records: Readonly<Record<string, FlashcardCard>>, dayStart: number): DoneToday {
  const out: DoneToday = { newCards: 0, reviews: 0, answers: 0, ms: 0 };
  for (const record of Object.values(records)) {
    const reviews = reviewsOf(record);
    let firstAnswer: number | null = null;
    for (const r of reviews) {
      if (r.rating === 'reset') {
        firstAnswer = null;
        continue;
      }
      if (firstAnswer === null) firstAnswer = r.at;
      if (r.at < dayStart) continue;
      out.answers++;
      out.ms += r.ms ?? 0;
      if (firstAnswer >= dayStart) {
        if (firstAnswer === r.at) out.newCards++;
      } else out.reviews++;
    }
  }
  return out;
}

export interface Counts {
  new: number;
  learning: number;
  review: number;
  total: number;
}

export interface DeckNode {
  /** Full deck name (`flashcards/bio`), '' for the vault root with folder decks. */
  name: string;
  /** Last segment, as shown. */
  label: string;
  depth: number;
  children: DeckNode[];
  /** Cards in this deck or below it (each card once). */
  items: StudyItem[];
  counts: Counts;
}

export function countItems(items: readonly StudyItem[], now: number, dayEnd: number): Counts {
  const counts: Counts = { new: 0, learning: 0, review: 0, total: items.length };
  for (const item of items) {
    const b = bucketOf(item, now, dayEnd);
    if (b !== 'later') counts[b]++;
  }
  return counts;
}

/** True when `item` is in `deck` or one of its sub-decks (case-insensitive). */
export function inDeck(item: StudyItem, deck: string): boolean {
  const d = deck.toLowerCase();
  return item.card.decks.some((x) => {
    const l = x.toLowerCase();
    return d === '' ? true : l === d || l.startsWith(d + '/');
  });
}

/** The deck tree, with counts that include sub-decks; the daily limits are applied by the caller. */
export function deckTree(items: readonly StudyItem[], now: number, dayEnd: number): DeckNode[] {
  const nodes = new Map<string, DeckNode>();
  const roots: DeckNode[] = [];
  const node = (name: string): DeckNode => {
    const key = name.toLowerCase();
    let n = nodes.get(key);
    if (n) return n;
    const slash = name.lastIndexOf('/');
    n = { name, label: slash >= 0 ? name.slice(slash + 1) : name, depth: name === '' ? 0 : name.split('/').length - 1, children: [], items: [], counts: { new: 0, learning: 0, review: 0, total: 0 } };
    nodes.set(key, n);
    if (slash >= 0) node(name.slice(0, slash)).children.push(n);
    else roots.push(n);
    return n;
  };
  for (const item of items) {
    const targets = new Set<DeckNode>();
    for (const deck of item.card.decks) {
      node(deck);
      // The deck and every parent count the card once.
      for (let name = deck; ; ) {
        const n = nodes.get(name.toLowerCase());
        if (n) targets.add(n);
        const slash = name.lastIndexOf('/');
        if (slash < 0) break;
        name = name.slice(0, slash);
      }
    }
    for (const t of targets) t.items.push(item);
  }
  const sort = (list: DeckNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const n of list) {
      n.counts = countItems(n.items, now, dayEnd);
      sort(n.children);
    }
  };
  sort(roots);
  return roots;
}

/** New and review counts capped by what the daily limits leave for today. */
export function limited(counts: Counts, config: Pick<FlashcardConfig, 'newPerDay' | 'reviewsPerDay'>, done: Pick<DoneToday, 'newCards' | 'reviews'>): Counts {
  return {
    ...counts,
    new: Math.min(counts.new, Math.max(0, config.newPerDay - done.newCards)),
    review: Math.min(counts.review, Math.max(0, config.reviewsPerDay - done.reviews)),
  };
}

/** The study day around `now`. */
export function studyDay(now: number, config: Pick<FlashcardConfig, 'dayStartsAt'>): { start: number; end: number } {
  return { start: studyDayStart(now, config.dayStartsAt), end: nextStudyDay(now, config.dayStartsAt) };
}

/** Record ids whose card is in no note (and was not adopted by an edited card). */
export function orphanRecords(items: readonly StudyItem[], records: Readonly<Record<string, FlashcardCard>>): string[] {
  const live = new Set<string>();
  for (const item of items) {
    live.add(item.card.id);
    if (item.from) live.add(item.from);
  }
  return Object.keys(records).filter((id) => !live.has(id));
}
