import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import type { VaultInfo, VaultsResponse } from '../../api/types';
import { openVault, showSwitcher } from '../../features/vaults';
import { setCurrentVaultForTests } from '../../state/vault';
import { VaultSwitcher } from './VaultSwitcher';
import { VaultsSettings } from './VaultsSettings';

const main: VaultInfo = { name: 'main', isDefault: true, state: 'ready', url: '/' };
const work: VaultInfo = { name: 'work', isDefault: false, state: 'ready', url: '/v/work/' };
const list = (vaults: VaultInfo[], canCreate = true): VaultsResponse => ({ vaults, canCreate });

function wrap(children: React.ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

describe('multiple vaults (ROADMAP item 37)', () => {
  beforeEach(() => queryClient.clear());
  afterEach(() => {
    setCurrentVaultForTests(null);
    vi.restoreAllMocks();
  });

  it('offers switching only when there is another vault', () => {
    expect(showSwitcher(undefined)).toBe(false);
    expect(showSwitcher(list([main]))).toBe(false);
    expect(showSwitcher(list([main, work]))).toBe(true);
    setCurrentVaultForTests('work');
    expect(showSwitcher(undefined)).toBe(true);
  });

  it('opens another vault with a full load, and never reloads the current one', () => {
    const assign = vi.fn();
    openVault(work, assign);
    expect(assign).toHaveBeenCalledWith('/v/work/');
    openVault(main, assign);
    expect(assign).toHaveBeenCalledTimes(1);
    setCurrentVaultForTests('work');
    openVault(main, assign);
    expect(assign).toHaveBeenLastCalledWith('/');
  });

  it('shows no switcher with a single vault', async () => {
    const listVaults = vi.spyOn(api, 'listVaults').mockResolvedValue(list([main]));
    const { container } = wrap(<VaultSwitcher />);
    await waitFor(() => expect(listVaults).toHaveBeenCalled());
    expect(container.querySelector('select')).toBeNull();
  });

  it('lists the vaults in the switcher, the current one selected', async () => {
    setCurrentVaultForTests('work');
    vi.spyOn(api, 'listVaults').mockResolvedValue(list([main, work, { name: 'new', isDefault: false, state: 'starting', url: '/v/new/' }]));
    wrap(<VaultSwitcher />);
    const select = await screen.findByRole('combobox', { name: 'Vault' });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('work'));
    const options = [...(select as HTMLSelectElement).options].map((o) => [o.textContent, o.disabled]);
    expect(options).toEqual([
      ['main', false],
      ['work', false],
      ['new (starting…)', true],
      ['Manage vaults…', false],
    ]);
  });

  it('creates a vault from Settings › Vaults', async () => {
    vi.spyOn(api, 'listVaults').mockResolvedValue(list([main]));
    const create = vi.spyOn(api, 'createVault').mockResolvedValue({ name: 'work', isDefault: false, state: 'starting', url: '/v/work/' });
    wrap(<VaultsSettings />);
    const input = await screen.findByRole('textbox', { name: 'New vault name' });
    const button = screen.getByRole('button', { name: /Create/ });
    fireEvent.change(input, { target: { value: 'Bad Name' } });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Use 1 to 32 lowercase letters/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Work' } });
    expect((input as HTMLInputElement).value).toBe('work');
    fireEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'work' }));
  });

  it('says when the server does not create vaults', async () => {
    vi.spyOn(api, 'listVaults').mockResolvedValue(list([main, work], false));
    wrap(<VaultsSettings />);
    expect(await screen.findByText(/does not create vaults/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open/ })).toBeEnabled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
