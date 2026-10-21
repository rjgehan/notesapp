// Settings › Hotkeys (ROADMAP item 29, DESIGN §6.25): every command with its key on this device.
// "Change" records the next key combination; a key another command uses can take it over (that
// command loses its key), keys the browser or the editor need are refused, and every change can
// be reset. Keys are stored per device, like the other "This device" preferences.
import { Keyboard, Pencil, RotateCcw, Search, X } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { allCommands, useCommandsVersion, type Command } from '../../features/commands';
import {
  conflictsWith,
  defaultHotkey,
  effectiveHotkey,
  isCustomized,
  reservedReason,
  resetAllHotkeys,
  resetHotkey,
  setHotkey,
  useHotkeyOverrides,
} from '../../features/hotkeyPrefs';
import { eventSpec } from '../../features/hotkeys';
import { keyLabel } from '../../features/platform';
import { confirmAction } from '../../state/dialogs';

interface Recording {
  id: string;
  /** A key that clashes with other commands, waiting for "Use it anyway". */
  pending: { spec: string; others: Command[] } | null;
  error: string | null;
}

function KeyChip({ spec }: { spec: string | null }) {
  return spec ? <kbd className="picker-kbd hotkey-chip">{keyLabel(spec)}</kbd> : <span className="muted hotkey-none">No key</span>;
}

export function HotkeysSection() {
  const version = useCommandsVersion();
  const overrides = useHotkeyOverrides();
  const [filter, setFilter] = useState('');
  const [recording, setRecording] = useState<Recording | null>(null);
  const commands = useMemo(() => (version >= 0 ? allCommands().sort((a, b) => a.name.localeCompare(b.name)) : []), [version]);
  const q = filter.trim().toLowerCase();
  const shown = commands.filter((c) => {
    if (q === '') return true;
    const key = effectiveHotkey(c, overrides);
    return c.name.toLowerCase().includes(q) || (key !== null && keyLabel(key).toLowerCase().includes(q));
  });
  const customized = Object.keys(overrides).length;

  const record = (c: Command, e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setRecording(null);
      return;
    }
    if (e.key === 'Tab') return;
    const spec = eventSpec(e.nativeEvent);
    e.preventDefault();
    e.stopPropagation();
    if (!spec) {
      setRecording({ id: c.id, pending: null, error: e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt' || e.key === 'Shift' ? null : 'Use a key with Ctrl, Cmd or Alt, or a function key' });
      return;
    }
    const reserved = reservedReason(spec);
    if (reserved) {
      setRecording({ id: c.id, pending: null, error: `${keyLabel(spec)} cannot be used: ${reserved}` });
      return;
    }
    const others = conflictsWith(spec, c.id);
    if (others.length > 0) {
      setRecording({ id: c.id, pending: { spec, others }, error: null });
      return;
    }
    setHotkey(c, spec);
    setRecording(null);
  };

  const takeOver = (c: Command, spec: string, others: Command[]) => {
    for (const o of others) setHotkey(o, null);
    setHotkey(c, spec);
    setRecording(null);
  };

  const resetAll = async () => {
    const ok = await confirmAction({ title: 'Reset all hotkeys?', message: 'Every command gets its default key back on this device.', confirmLabel: 'Reset' });
    if (ok) resetAllHotkeys();
  };

  return (
    <>
      <p className="setting-note">
        <Keyboard size={14} aria-hidden /> Hotkeys are kept on this device only, so a laptop and a desktop can differ.
      </p>
      <div className="hotkeys-toolbar">
        <div className="search-field hotkeys-filter">
          <Search size={15} className="search-field-icon" aria-hidden />
          <input className="text-input search-input" type="search" placeholder="Filter commands or keys…" aria-label="Filter commands" value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <button type="button" className="button" disabled={customized === 0} onClick={() => void resetAll()}>
          <RotateCcw size={14} aria-hidden /> Reset all
        </button>
      </div>
      <ul className="hotkeys-list" aria-label="Commands and their keys">
        {shown.map((c) => {
          const key = effectiveHotkey(c, overrides);
          const custom = isCustomized(c.id, overrides);
          const def = defaultHotkey(c);
          const active = recording?.id === c.id ? recording : null;
          return (
            <li key={c.id} className={`setting-row hotkey-row${custom ? ' is-custom' : ''}`}>
              <div className="setting-info">
                <div className="setting-label">{c.name}</div>
                {custom && <div className="setting-description">Default: {def ? keyLabel(def) : 'no key'}</div>}
                {active?.error && <div className="field-error">{active.error}</div>}
                {active?.pending && (
                  <div className="field-warning hotkey-conflict" role="alert">
                    {keyLabel(active.pending.spec)} is used by {active.pending.others.map((o) => `“${o.name}”`).join(', ')}.{' '}
                    <button type="button" className="button button-small" onClick={() => takeOver(c, active.pending!.spec, active.pending!.others)}>
                      Use it here instead
                    </button>{' '}
                    <button type="button" className="button button-small" onClick={() => setRecording(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div className="setting-control hotkey-control">
                {active && !active.pending ? (
                  <button
                    type="button"
                    className="button hotkey-recorder"
                    data-hotkey-recorder
                    autoFocus
                    aria-label={`Press the new key for ${c.name}, or Escape to cancel`}
                    onKeyDown={(e) => record(c, e)}
                    onBlur={() => setRecording((r) => (r?.id === c.id && !r.pending ? null : r))}
                  >
                    Press a key…
                  </button>
                ) : (
                  <KeyChip spec={key} />
                )}
                <button type="button" className="icon-button" aria-label={`Change the key of ${c.name}`} title="Change the key" onClick={() => setRecording({ id: c.id, pending: null, error: null })}>
                  <Pencil size={15} />
                </button>
                {key !== null && (
                  <button type="button" className="icon-button" aria-label={`Remove the key of ${c.name}`} title="Remove the key" onClick={() => setHotkey(c, null)}>
                    <X size={15} />
                  </button>
                )}
                {custom && (
                  <button type="button" className="icon-button" aria-label={`Reset the key of ${c.name}`} title="Reset to the default" onClick={() => resetHotkey(c.id)}>
                    <RotateCcw size={15} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="muted">No command matches “{filter}”.</p>}
    </>
  );
}
