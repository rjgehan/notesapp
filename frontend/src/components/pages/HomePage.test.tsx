import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import { registerBuiltins } from '../../extensions/builtins';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { HomePage } from './HomePage';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('HomePage (FE-15, ux)', () => {
  it('shows the home page when the startup daily note cannot be opened, instead of a blank loader', async () => {
    registerBuiltins();
    queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [] });
    queryClient.setQueryData(queryKeys.settings(), {
      settings: { ...DEFAULT_SETTINGS, dailyNotes: { ...DEFAULT_SETTINGS.dailyNotes, format: 'HH:mm', openOnStartup: true } },
      version: 'v1',
      readOnly: false,
    });
    vi.spyOn(api, 'createFile').mockRejectedValue(new ApiError({ type: 'urn:notesapp:problem:invalid-name', title: 'invalid', status: 400, code: 'invalid-name' }));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('No note is open')).toBeInTheDocument();
  });
});
