// Command palette (DESIGN §6.13, Mod-P): fuzzy search over the available commands (global ones and
// those of the active view), recently used first, each row with its hotkey.
import { useMemo, useState } from 'react';
import { availableCommands, recentCommandIds, runCommand, useCommandsVersion, type Command } from '../../features/commands';
import { fuzzyRank } from '../../features/fuzzy';
import { effectiveHotkey, useHotkeyOverrides } from '../../features/hotkeyPrefs';
import { activePath } from '../../features/navigation';
import { keyLabel } from '../../features/platform';
import { useUi } from '../../state/ui';
import { Picker } from './Picker';

/** Recently used commands get a small boost so they lead among equally good matches. */
function rankCommands(query: string, commands: Command[], recent: string[]): Command[] {
  const order = new Map(recent.map((id, i) => [id, i]));
  const recency = (c: Command) => order.get(c.id) ?? Infinity;
  if (query.trim() === '') {
    return [...commands].sort((a, b) => recency(a) - recency(b) || a.name.localeCompare(b.name));
  }
  return fuzzyRank(query, commands, [(c) => c.name], 100, (c) => (order.has(c.id) ? 0.02 * (1 - recency(c) / 20) : 0)).map((r) => r.item);
}

export function CommandPalette() {
  useCommandsVersion();
  const overrides = useHotkeyOverrides();
  const [query, setQuery] = useState('');
  const [ctx] = useState(() => ({ activePath: activePath() }));
  const [recent] = useState(recentCommandIds);
  const commands = useMemo(() => availableCommands(ctx).filter((c) => c.id !== 'app.commandPalette'), [ctx]);
  const items = useMemo(() => rankCommands(query, commands, recent), [query, commands, recent]);
  const close = () => useUi.getState().setOverlay(null);

  return (
    <Picker
      label="Command palette"
      placeholder="Type a command…"
      query={query}
      onQuery={setQuery}
      items={items}
      itemKey={(c) => c.id}
      renderItem={(c) => {
        const key = effectiveHotkey(c, overrides);
        return (
          <>
            <span className="picker-item-text">
              <span className="picker-item-label">{c.name}</span>
            </span>
            {key && <kbd className="picker-kbd">{keyLabel(key)}</kbd>}
          </>
        );
      }}
      onPick={(c) => {
        close();
        runCommand(c.id, ctx);
      }}
      onClose={close}
      empty="No matching commands."
    />
  );
}
