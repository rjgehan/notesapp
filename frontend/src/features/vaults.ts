// Multiple vaults (ROADMAP item 37, DESIGN §6.44): the server's vault list, opening another vault
// (a full load of its app, so nothing of this vault's state carries over) and creating one.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import type { VaultInfo, VaultsResponse } from '../api/types';
import { currentVault } from '../state/vault';

export const VAULTS_KEY = ['vaults'] as const;

/** The vault list; while a vault is starting, the list is asked for again every 2 s. */
export function useVaults() {
  return useQuery({
    queryKey: VAULTS_KEY,
    queryFn: () => api.listVaults(),
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.vaults.some((v) => v.state === 'starting') ? 2000 : false),
  });
}

/** True for the vault this page shows. */
export function isCurrent(vault: VaultInfo): boolean {
  const current = currentVault();
  return current === null ? vault.isDefault : vault.name === current;
}

/** The vault this page shows, from the list; null while it loads or when the server does not know it. */
export function currentVaultInfo(list: VaultsResponse | undefined): VaultInfo | null {
  return list?.vaults.find(isCurrent) ?? null;
}

/** Whether to offer switching: more than one vault, or this page shows an extra one. */
export function showSwitcher(list: VaultsResponse | undefined): boolean {
  return currentVault() !== null || (list?.vaults.length ?? 0) > 1;
}

/** Opens a vault's app. A full page load: the caches, the event stream and the open tabs are per vault. */
export function openVault(vault: VaultInfo, assign: (url: string) => void = (url) => window.location.assign(url)): void {
  if (isCurrent(vault)) return;
  assign(vault.url);
}

/** Creates a vault; the list shows it as starting until its context is ready. */
export async function createVault(name: string): Promise<VaultInfo> {
  const created = await api.createVault({ name });
  await queryClient.invalidateQueries({ queryKey: VAULTS_KEY });
  return created;
}
