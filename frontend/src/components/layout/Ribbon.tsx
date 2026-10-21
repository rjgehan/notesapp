// Ribbon (desktop) and collapsed icon rail (tablet): one tap to every entry point (DESIGN §6.5,
// §6.16). Entries appear once their command or page is registered.
import { CalendarDays, Command as CommandIcon, FilePlus, FileSearch, LayoutTemplate, Moon, PanelLeft, Search, Settings, Sun, Trash, type LucideIcon } from 'lucide-react';
import { pageRoute, registeredPages, useExtensionsVersion } from '../../extensions';
import { getCommand, runCommand, useCommandsVersion } from '../../features/commands';
import { activePath, navigateTo } from '../../features/navigation';
import { effectiveHotkey, useHotkeyOverrides } from '../../features/hotkeyPrefs';
import { keyLabel } from '../../features/platform';
import { resolvedTheme, usePrefs } from '../../state/prefs';
import { toggleSidebar } from './showPanel';

const TOP: Array<[string, LucideIcon]> = [
  ['app.quickSwitcher', FileSearch],
  ['search.open', Search],
  ['daily.today', CalendarDays],
  ['templates.insert', LayoutTemplate],
  ['file.newNote', FilePlus],
  ['app.commandPalette', CommandIcon],
];

const BOTTOM: Array<[string, LucideIcon]> = [
  ['trash.open', Trash],
  ['settings.open', Settings],
];

function RibbonButton({ id, icon: Icon }: { id: string; icon: LucideIcon }) {
  const overrides = useHotkeyOverrides();
  const command = getCommand(id);
  if (!command) return null;
  const key = effectiveHotkey(command, overrides);
  const label = command.name + (key ? ` (${keyLabel(key)})` : '');
  return (
    <button type="button" className="ribbon-button" aria-label={command.name} title={label} onClick={() => runCommand(id, { activePath: activePath() })}>
      <Icon size={18} aria-hidden />
    </button>
  );
}

export function Ribbon() {
  useCommandsVersion();
  useExtensionsVersion();
  usePrefs((s) => s.theme);
  const dark = resolvedTheme() === 'dark';

  return (
    <nav className="ribbon" aria-label="Ribbon">
      <div className="ribbon-group">
        <button
          type="button"
          className="ribbon-button"
          aria-label="Toggle left sidebar"
          title="Toggle left sidebar"
          onClick={() => toggleSidebar('left')}
        >
          <PanelLeft size={18} aria-hidden />
        </button>
        {TOP.map(([id, icon]) => (
          <RibbonButton key={id} id={id} icon={icon} />
        ))}
        {registeredPages().map((p) => {
          const Icon = p.icon;
          return (
            <button key={p.route} type="button" className="ribbon-button" aria-label={p.title} title={p.title} onClick={() => navigateTo(pageRoute(p))}>
              <Icon size={18} aria-hidden />
            </button>
          );
        })}
      </div>
      <div className="ribbon-group">
        {BOTTOM.map(([id, icon]) => (
          <RibbonButton key={id} id={id} icon={icon} />
        ))}
        <button
          type="button"
          className="ribbon-button"
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => runCommand('theme.toggle', { activePath: activePath() })}
        >
          {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
        </button>
      </div>
    </nav>
  );
}
