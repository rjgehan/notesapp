// The flashcard endpoints (API.md §34). Kept beside the feature, as the task endpoints are: the
// dev-only in-memory mock implements the vault API only.
import { apiFetch } from '../api/client';
import type {
  FlashcardConfig,
  FlashcardConfigUpdateRequest,
  FlashcardNotesResponse,
  FlashcardReview,
  FlashcardsResponse,
  FlashcardUndoRequest,
  FlashcardWriteResult,
} from '../api/types';

export const flashcardApi = {
  state: () => apiFetch<FlashcardsResponse>('/api/flashcards'),
  notes: () => apiFetch<FlashcardNotesResponse>('/api/flashcards/notes'),
  review: (reviews: FlashcardReview[]) => apiFetch<FlashcardWriteResult>('/api/flashcards/reviews', { method: 'POST', json: { reviews } }),
  undo: (req: FlashcardUndoRequest) => apiFetch<FlashcardWriteResult>('/api/flashcards/undo', { method: 'POST', json: req }),
  prune: (cards: string[]) => apiFetch<FlashcardWriteResult>('/api/flashcards/prune', { method: 'POST', json: { cards } }),
  config: (config: FlashcardConfigUpdateRequest['config']) => apiFetch<FlashcardConfig>('/api/flashcards/config', { method: 'PUT', json: { config } }),
};
