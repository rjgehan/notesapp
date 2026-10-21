import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { MirrorStatus, StatusResponse } from '../../api/types';
import { MockVault } from '../../api/mock/vault';
import { StatusBar } from './StatusBar';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

function statusWith(mirror: Partial<MirrorStatus>): StatusResponse {
  const status = new MockVault().getStatus();
  return { ...status, mirror: { ...status.mirror, ...mirror } };
}

function renderBar(status: StatusResponse) {
  queryClient.setQueryData(queryKeys.status(), status);
  vi.spyOn(api, 'getStatus').mockResolvedValue(status);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StatusBar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StatusBar mirror warning (DESIGN §6.18)', () => {
  it('shows a failing mirror with its error, and pushes again on click', async () => {
    const push = vi.spyOn(api, 'pushMirror').mockResolvedValue(statusWith({ state: 'failing', pushing: true }).mirror);
    renderBar(statusWith({ state: 'failing', remote: 'https://github.com/me/vault.git', lastError: 'not authorized', failingSince: new Date(Date.now() - 3 * 60_000).toISOString() }));
    const warning = screen.getByRole('button', { name: /Mirror is not being updated \(for 3 minutes\)/ });
    expect(warning).toHaveAttribute('title', 'not authorized\nClick to push now.');
    fireEvent.click(warning);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  });

  it('shows a diverged mirror', () => {
    renderBar(statusWith({ state: 'diverged', remote: 'https://github.com/me/vault.git' }));
    expect(screen.getByRole('button', { name: /Mirror stopped/ })).toBeInTheDocument();
  });

  it('shows a mirror whose settings cannot be used, with nothing to click', () => {
    const push = vi.spyOn(api, 'pushMirror');
    renderBar(statusWith({ state: 'disabled', reason: 'the mirror URL is not a valid URL', remote: 'git@github.com:me/vault.git' }));
    const warning = screen.getByText('Mirror is off: the mirror URL is not a valid URL');
    expect(warning).toHaveAttribute('title', expect.stringMatching(/^Nothing is pushed until/));
    expect(screen.queryByRole('button', { name: /Mirror/ })).not.toBeInTheDocument();
    fireEvent.click(warning);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows nothing while the mirror is off or working', () => {
    renderBar(statusWith({}));
    expect(screen.queryByRole('button', { name: /Mirror/ })).not.toBeInTheDocument();
  });
});
