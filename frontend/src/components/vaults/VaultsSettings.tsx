// Settings › Vaults (ROADMAP item 37, DESIGN §6.41): every vault on the server, opening one, and
// creating a new, empty one when the server allows it.
import { FolderOpen, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../../api/client';
import type { VaultInfo } from '../../api/types';
import { createVault, isCurrent, openVault, useVaults } from '../../features/vaults';
import { isValidVaultName } from '../../state/vault';
import '../../styles/vaults.css';

const STATE_LABELS: Record<VaultInfo['state'], string> = { starting: 'Starting…', ready: '', failed: 'Could not be started: see the server log' };

function VaultRow({ vault }: { vault: VaultInfo }) {
  const current = isCurrent(vault);
  return (
    <li className="vault-row">
      <div className="vault-row-head">
        <strong>{vault.name}</strong>
        {vault.isDefault && <span className="vault-tag">default</span>}
        {current && <span className="vault-tag vault-tag-current">this vault</span>}
        {STATE_LABELS[vault.state] && <span className="muted">{STATE_LABELS[vault.state]}</span>}
      </div>
      {!current && (
        <button type="button" className="button" disabled={vault.state !== 'ready'} onClick={() => openVault(vault)}>
          <FolderOpen size={14} aria-hidden /> Open
        </button>
      )}
    </li>
  );
}

function CreateVault() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isValidVaultName(name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createVault(name);
      setName('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="vault-create" onSubmit={(e) => void submit(e)}>
      <div className="setting-row">
        <div className="setting-info">
          <div className="setting-label">New vault</div>
          <div className="setting-description">
            Lowercase letters, digits and dashes. The name is the vault’s folder on the server and part of its address
            (/v/name/).
          </div>
          {name !== '' && !valid && (
            <div className="field-error">Use 1 to 32 lowercase letters, digits and dashes, starting and ending with a letter or digit.</div>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="setting-control vault-create-control">
          <input
            className="text-input"
            value={name}
            maxLength={32}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="work"
            aria-label="New vault name"
            aria-invalid={name !== '' && !valid}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <button type="submit" className="button button-primary" disabled={!valid || busy}>
            <Plus size={14} aria-hidden /> Create
          </button>
        </div>
      </div>
    </form>
  );
}

export function VaultsSettings() {
  const query = useVaults();
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="field-error">{errorMessage(query.error)}</p>;
  const { vaults, canCreate } = query.data;
  return (
    <div className="vaults-settings">
      <p className="vaults-explain">
        Each vault is a separate set of notes with its own search, links, history, trash, settings, bookmarks, tasks and
        reminders. Switching vaults reloads the app. Publishing, the history mirror, the share sheet and the web clipper
        use the default vault.
      </p>
      <ul className="vault-list">
        {vaults.map((v) => (
          <VaultRow key={v.name} vault={v} />
        ))}
      </ul>
      {canCreate ? (
        <CreateVault />
      ) : (
        <p className="muted">This server does not create vaults from the app (NOTES_VAULTS_DIR, NOTES_VAULTS_ALLOW_CREATE).</p>
      )}
    </div>
  );
}
