// The flashcards of the vault, for the pages (DESIGN §6.34): the notes that may hold cards
// (parsed here, cached per note version), the review records with this device's pending answers
// over them, and each card's FSRS state.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { FSRS } from 'ts-fsrs';
import type { FlashcardCard, FlashcardConfig, FlashcardNote } from '../api/types';
import { flashcardApi } from './api';
import { studyItems, type StudyItem } from './deck';
import { parseCards, type ParsedCard } from './parse';
import { schedulerFor } from './schedule';
import { flashcardKeys, outbox, overlay, type OutboxOp } from './store';

const parsed = new Map<string, { version: string; key: string; cards: ParsedCard[] }>();

/** Every card of `notes`, in path order; each note is parsed once per version and settings. */
export function parseNotes(notes: readonly FlashcardNote[], config: Pick<FlashcardConfig, 'tags' | 'foldersAsDecks'>): ParsedCard[] {
  const key = JSON.stringify([config.tags, config.foldersAsDecks]);
  const out: ParsedCard[] = [];
  for (const note of notes) {
    let hit = parsed.get(note.path);
    if (!hit || hit.version !== note.version || hit.key !== key) {
      hit = { version: note.version, key, cards: parseCards(note.path, note.content, config) };
      parsed.set(note.path, hit);
    }
    out.push(...hit.cards);
  }
  return out;
}

const NO_OPS: readonly OutboxOp[] = [];
const noSubscribe = () => () => {};

export interface FlashcardData {
  loading: boolean;
  error: unknown;
  config: FlashcardConfig | null;
  records: Record<string, FlashcardCard>;
  items: StudyItem[];
  scheduler: FSRS | null;
  notes: number;
  pending: number;
}

export function useFlashcards(): FlashcardData {
  const state = useQuery({ queryKey: flashcardKeys.state, queryFn: flashcardApi.state, staleTime: Infinity });
  const notes = useQuery({ queryKey: flashcardKeys.notes, queryFn: flashcardApi.notes, staleTime: 0 });
  const box = outbox();
  const ops = useSyncExternalStore(box?.subscribe ?? noSubscribe, box?.snapshot ?? (() => NO_OPS));
  const config = state.data?.config ?? notes.data?.config ?? null;
  const notesConfig = notes.data?.config ?? null;
  const cards = useMemo(() => (notes.data && notesConfig ? parseNotes(notes.data.notes, notesConfig) : []), [notes.data, notesConfig]);
  const records = useMemo(() => overlay(state.data?.cards ?? {}, ops), [state.data, ops]);
  const scheduler = useMemo(() => (config ? schedulerFor(config) : null), [config]);
  const items = useMemo(() => (scheduler ? studyItems(cards, records, scheduler) : []), [cards, records, scheduler]);
  return {
    loading: state.isPending || notes.isPending,
    error: state.error ?? notes.error,
    config,
    records,
    items,
    scheduler,
    notes: notes.data?.notes.length ?? 0,
    pending: ops.length,
  };
}

/** The time, ticking every `ms`, so due counts follow the clock. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}
