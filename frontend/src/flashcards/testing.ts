// Shared test fixtures.
import type { FlashcardConfig } from '../api/types';

export const CONFIG: FlashcardConfig = {
  tags: ['flashcards'],
  foldersAsDecks: false,
  newPerDay: 20,
  reviewsPerDay: 200,
  retention: 0.9,
  maximumInterval: 36500,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  fuzz: true,
  dayStartsAt: 4,
};
