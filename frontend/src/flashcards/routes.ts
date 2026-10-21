// Locations of the flashcards page (`/x/flashcards`, DESIGN §6.34).

export const FLASHCARDS_ROUTE = '/x/flashcards';

export interface Scope {
  /** A deck (and its sub-decks), or null for every deck. */
  deck: string | null;
  /** Only the cards of this note (no daily limits). */
  note: string | null;
}

/** The page's location for a view. */
export function flashcardsUrl(view: 'decks' | 'review' | 'stats' | 'settings', scope: Partial<Scope> = {}): string {
  const params = new URLSearchParams();
  if (view !== 'decks') params.set('view', view);
  if (scope.deck !== undefined && scope.deck !== null) params.set('deck', scope.deck);
  if (scope.note) params.set('note', scope.note);
  const q = params.toString();
  return FLASHCARDS_ROUTE + (q ? '?' + q : '');
}
