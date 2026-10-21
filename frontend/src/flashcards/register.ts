// Flashcards (ROADMAP item 34, DESIGN §6.34) through the extension points of DESIGN §6.8: the
// `/x/flashcards` page, palette commands, and the event handlers that keep records and source
// notes live.
import { BarChart3, Layers, Play } from 'lucide-react';
import { queryClient } from '../api/queryClient';
import type { FlashcardsChangedEvent } from '../api/types';
import { registerCommand, registerEventHandler, registerPage } from '../extensions';
import { toastError } from '../features/errors';
import { navigateTo } from '../features/navigation';
import { useUi } from '../state/ui';
import { flashcardsUrl, type Scope } from './routes';
import { applyChangedEvent, flashcardKeys, installOutbox, outbox } from './store';

/** A note saved elsewhere may have gained or lost cards; an open flashcards page refetches. */
const NOTE_EVENTS = ['file.created', 'file.changed', 'file.deleted', 'entry.moved', 'folder.deleted'];
const REFRESH_DEBOUNCE_MS = 1000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNotesRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void queryClient.invalidateQueries({ queryKey: flashcardKeys.notes });
  }, REFRESH_DEBOUNCE_MS);
}

function open(view: 'review' | 'stats', scope: Partial<Scope> = {}): void {
  useUi.getState().setDrawerOpen(false);
  navigateTo(flashcardsUrl(view, scope));
}

let registered = false;

export function registerFlashcards(): void {
  if (registered) return;
  registered = true;
  registerPage({ route: 'flashcards', title: 'Flashcards', icon: Layers, load: () => import('./ui/FlashcardsPage') });
  registerCommand({ id: 'flashcards.review', name: 'Review flashcards', icon: Play, run: () => open('review') });
  registerCommand({
    id: 'flashcards.reviewNote',
    name: 'Review flashcards in this note',
    icon: Play,
    when: (c) => c.activePath !== null && c.activePath.toLowerCase().endsWith('.md'),
    run: (c) => open('review', { note: c.activePath }),
  });
  registerCommand({ id: 'flashcards.stats', name: 'Show flashcard statistics', icon: BarChart3, run: () => open('stats') });
  registerEventHandler('flashcards.changed', (data) => applyChangedEvent(queryClient, data as FlashcardsChangedEvent));
  for (const name of NOTE_EVENTS) registerEventHandler(name, scheduleNotesRefresh);
  installOutbox(queryClient, (e) => toastError(e, 'An answer could not be saved'));
  // Answers given offline go out once the event stream has caught up again.
  useUi.subscribe((s, prev) => {
    if (s.caughtUp && !prev.caughtUp) outbox()?.retryNow();
  });
}
