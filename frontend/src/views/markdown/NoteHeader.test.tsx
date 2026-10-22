import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import { registerBuiltins } from '../../extensions/builtins';
import { currentNoteMode } from '../../features/noteMode';
import { useUi } from '../../state/ui';
import { NoteHeader } from './NoteHeader';
import { noteMenuItems, sourceItemLabel } from './noteMenu';

function desktop(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('min-width: 1200px'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  registerBuiltins();
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [] });
  window.history.replaceState(null, '', '/n/Plan.md');
  useUi.setState({ noteModes: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  useUi.setState({ noteModes: {} });
  document.querySelectorAll('[role="menu"]').forEach((m) => m.parentElement?.remove());
});

function header(mode: 'live' | 'source' = 'live') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/n/Plan.md']}>
        <NoteHeader path="Plan.md" snapshot={null} mode={mode} editable />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the note header has no mode toggles (DESIGN §6.6.1)', () => {
  it('shows no lock, reading or source toggle on desktop', () => {
    desktop();
    header();
    expect(screen.queryByRole('button', { name: /lock editing|switch to|source mode|reading/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Note actions' })).toBeInTheDocument();
  });

  it('its ⋯ menu offers "Show Markdown source", which shows the source', async () => {
    desktop();
    header();
    fireEvent.click(screen.getByRole('button', { name: 'Note actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show Markdown source' }));
    expect(currentNoteMode()).toBe('source');
  });

  it('in source mode the item reads "Back to normal view" and goes back to Live Preview', () => {
    useUi.setState({ noteModes: { 'Plan.md': 'source' } });
    const items = noteMenuItems('Plan.md', 'source');
    const first = items[0];
    expect(first !== 'separator' && first.label).toBe('Back to normal view');
    if (first !== 'separator') first.run();
    expect(currentNoteMode()).toBe('live');
    expect(sourceItemLabel('live')).toBe('Show Markdown source');
  });
});
