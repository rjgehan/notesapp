import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { startPendingNote, updatePendingTitle, usePendingNote } from '../../state/pendingNote';
import { PendingNoteView } from './PendingNoteView';

function view() {
  return (
    <QueryClientProvider client={queryClient}>
      <PendingNoteView pending={usePendingNote.getState().pending!} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  usePendingNote.setState({ pending: null, handoff: null });
  queryClient.clear();
});

describe('PendingNoteView', () => {
  it('asks for a new note’s name, then for writing', () => {
    queryClient.setQueryData(queryKeys.settings(), { settings: DEFAULT_SETTINGS, version: 'v1', readOnly: false });
    startPendingNote(1, '', 'Untitled');
    render(view());
    expect(screen.getByLabelText('Note title')).toHaveValue('Untitled');
    expect(screen.getByText('Name the new note, then start writing.')).toBeInTheDocument();
  });

  it('names a new drawing as a drawing, which opens once its name is committed', () => {
    queryClient.setQueryData(queryKeys.settings(), { settings: DEFAULT_SETTINGS, version: 'v1', readOnly: false });
    startPendingNote(2, '', 'Untitled', { extension: 'excalidraw', label: 'drawing' });
    const { rerender } = render(view());
    expect(screen.getByLabelText('Drawing title')).toHaveValue('Untitled');
    expect(screen.getByText('Name the new drawing, then press Enter to open it.')).toBeInTheDocument();
    updatePendingTitle(2, 'Plan', true);
    rerender(view());
    expect(screen.getByText('Creating the drawing…')).toBeInTheDocument();
  });
});
