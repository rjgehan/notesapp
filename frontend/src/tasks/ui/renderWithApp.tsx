// Renders a task component the way the app does (shared query client, router), for tests.
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { queryClient } from '../../api/queryClient';

export function renderWithApp(ui: ReactElement, opts: { path?: string; route?: string } = {}) {
  const path = opts.path ?? '/';
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        {opts.route ? (
          <Routes>
            <Route path={opts.route} element={ui} />
          </Routes>
        ) : (
          ui
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
