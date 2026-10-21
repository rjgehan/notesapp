import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { FlashcardNotesResponse, FlashcardReview, FlashcardsResponse } from '../../api/types';
import { EMPTY_TREE } from '../../api/vaultTree';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { flashcardApi } from '../api';
import { installOutbox } from '../store';
import { CONFIG } from '../testing';
import FlashcardsPage from './FlashcardsPage';

vi.mock('../api', () => ({
  flashcardApi: { state: vi.fn(), notes: vi.fn(), review: vi.fn(), undo: vi.fn(), prune: vi.fn(), config: vi.fn() },
}));

const NOTE = '#flashcards/spanish\nhola::hello\nadiós::goodbye\n\n#flashcards/math\n2+2::4\n';

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <FlashcardsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), EMPTY_TREE);
  queryClient.setQueryData(queryKeys.settings(), { settings: DEFAULT_SETTINGS, version: 'v', readOnly: false });
  const state: FlashcardsResponse = { config: CONFIG, cards: {}, version: null };
  const notes: FlashcardNotesResponse = { config: CONFIG, notes: [{ path: 'Cards/Spanish.md', version: 'v1', content: NOTE }] };
  vi.mocked(flashcardApi.state).mockResolvedValue(state);
  vi.mocked(flashcardApi.notes).mockResolvedValue(notes);
  vi.mocked(flashcardApi.review).mockImplementation(async (reviews: FlashcardReview[]) => ({ cards: {}, version: 'v2', reviews } as never));
  vi.mocked(flashcardApi.undo).mockResolvedValue({ cards: {}, version: 'v3' });
  installOutbox(queryClient, () => {});
});

afterEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('FlashcardsPage', () => {
  it('lists the decks with what is due today', async () => {
    renderAt('/x/flashcards');
    expect(await screen.findByText('cards to study today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Study spanish: 2 new, 0 learning, 0 to review, 2 cards/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Study math: 1 new/ })).toBeInTheDocument();
    expect(screen.getByText(/3 cards in 1 note/)).toBeInTheDocument();
  });

  it('shows how to write cards when there are none', async () => {
    vi.mocked(flashcardApi.notes).mockResolvedValue({ config: CONFIG, notes: [] });
    renderAt('/x/flashcards');
    expect(await screen.findByText('No flashcards yet')).toBeInTheDocument();
    expect(screen.getByText(/Capital of France::Paris/)).toBeInTheDocument();
  });

  it('reviews from the keyboard, sends each answer with its state, and undoes', async () => {
    renderAt('/x/flashcards?view=review&deck=flashcards/spanish');
    expect(await screen.findByText('hola')).toBeInTheDocument();
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Good/ })).toHaveTextContent('10m');
    fireEvent.keyDown(window, { key: '3' });
    expect(await screen.findByText('adiós')).toBeInTheDocument();
    await waitFor(() => expect(flashcardApi.review).toHaveBeenCalledTimes(1));
    const [sent] = vi.mocked(flashcardApi.review).mock.calls[0][0];
    expect(sent).toMatchObject({ rating: 'good', note: 'Cards/Spanish.md', front: 'hola', state: { phase: 'learning', n: 1 } });
    expect(sent.state!.lastReview).toBe(sent.at);

    fireEvent.keyDown(window, { key: 'u' });
    expect(await screen.findByText('hola')).toBeInTheDocument();
    await waitFor(() => expect(flashcardApi.undo).toHaveBeenCalledWith({ card: sent.card, at: sent.at, state: undefined }));
  });

  it('answers with the buttons and finishes', async () => {
    renderAt('/x/flashcards?view=review&deck=flashcards/math');
    fireEvent.click(await screen.findByText('2+2'));
    fireEvent.click(await screen.findByRole('button', { name: /Easy/ }));
    expect(await screen.findByText('Done for now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to decks' })).toBeInTheDocument();
    await act(async () => {});
    expect(flashcardApi.review).toHaveBeenCalledTimes(1);
  });
});
