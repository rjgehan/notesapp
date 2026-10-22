// The vault switcher (ROADMAP item 37, DESIGN §6.44): at the top of the left sidebar on a desktop,
// and of the drawer on a phone or tablet. Shown only once there is another vault to switch to.
// A native select, so a phone shows its own picker.
import { Library } from 'lucide-react';
import { navigateTo } from '../../features/navigation';
import { currentVaultInfo, openVault, showSwitcher, useVaults } from '../../features/vaults';
import { useUi } from '../../state/ui';
import { currentVault } from '../../state/vault';
import '../../styles/vaults.css';

const MANAGE = '__manage__';

export function VaultSwitcher() {
  const { data } = useVaults();
  if (!showSwitcher(data)) return null;
  const current = currentVaultInfo(data);
  const value = current?.name ?? currentVault() ?? '';
  return (
    <div className="vault-switcher">
      <Library size={15} aria-hidden />
      <select
        className="vault-select"
        aria-label="Vault"
        title="Switch vault"
        value={value}
        onChange={(e) => {
          if (e.target.value === MANAGE) {
            useUi.getState().setDrawerOpen(false);
            navigateTo('/settings/vaults');
            return;
          }
          const vault = data?.vaults.find((v) => v.name === e.target.value);
          if (vault) openVault(vault);
        }}
      >
        {!current && <option value={value}>{value}</option>}
        {data?.vaults.map((v) => (
          <option key={v.name} value={v.name} disabled={v.state !== 'ready'}>
            {v.name}
            {v.state === 'starting' ? ' (starting…)' : v.state === 'failed' ? ' (failed to start)' : ''}
          </option>
        ))}
        <option value={MANAGE}>Manage vaults…</option>
      </select>
    </div>
  );
}
