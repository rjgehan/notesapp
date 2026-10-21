import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { MirrorStatus, StatusResponse } from '../../api/types';
import { registerBuiltins } from '../../extensions/builtins';
import { TopBar } from './TopBar';

beforeEach(() => {
  registerBuiltins();
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

function renderAt(pathname: string, mirror: Partial<MirrorStatus> = {}) {
  const vault = new MockVault();
  const status = vault.getStatus();
  const withMirror: StatusResponse = { ...status, mirror: { ...status.mirror, ...mirror } };
  vi.spyOn(api, 'getTree').mockResolvedValue(vault.getTree());
  vi.spyOn(api, 'getStatus').mockResolvedValue(withMirror);
  queryClient.setQueryData(queryKeys.status(), withMirror);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[pathname]}>
        <TopBar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const title = () => document.querySelector('.top-bar-name')?.textContent;

describe('TopBar (phone and tablet, DESIGN §6.16)', () => {
  it('names a registered page by its title', () => {
    renderAt('/x/status');
    expect(title()).toBe('Status');
  });

  it('names the built-in pages', () => {
    const trash = renderAt('/trash');
    expect(title()).toBe('Trash');
    trash.unmount();
    renderAt('/search');
    expect(title()).toBe('Search');
  });

  it('falls back to Notes for an unknown page', () => {
    renderAt('/x/no-such-page');
    expect(title()).toBe('Notes');
  });

  it('warns about a mirror whose settings cannot be used, without offering a push', () => {
    renderAt('/', { state: 'disabled', reason: 'the mirror URL is not a valid URL', remote: 'git@github.com:me/vault.git' });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('Mirror is off: the mirror URL is not a valid URL')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Push to mirror now' })).not.toBeInTheDocument();
  });

  it('offers a push for a failing mirror', () => {
    renderAt('/', { state: 'failing', remote: 'https://github.com/me/vault.git', lastError: 'not authorized' });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('Mirror is not being updated')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Push to mirror now' })).toBeInTheDocument();
  });
});
