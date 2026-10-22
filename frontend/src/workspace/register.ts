// Tabs and split panes (ROADMAP item 11, DESIGN §6.40) through the extension points of §6.8: the
// new-tab page, the tab and pane commands, and the "open in a new tab" gestures.
import { Columns2, CopyPlus, PanelTop, Pin, Plus, RotateCcw, Rows2, X } from 'lucide-react';
import { registerCommand, registerPage } from '../extensions';
import { noteRoute } from '../features/paths';
import { setNewTabOpener } from '../features/navigation';
import { useUi } from '../state/ui';
import { installTabGestures } from './gesture';
import { activeTab, NEW_TAB_ROUTE } from './model';
import {
  closeActiveTab,
  closePaneById,
  cycleTab,
  focusNextPane,
  newTab,
  openInNewTab,
  reopenClosedTab,
  splitActive,
  togglePinTab,
  workspace,
} from './store';
import { TAB_SWITCHER } from './TabSwitcher';

let registered = false;

const many = () => Object.keys(workspace().panes).length > 1;
const phone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;

export function registerWorkspace(): void {
  if (registered) return;
  registered = true;
  registerPage({ route: NEW_TAB_ROUTE.slice(3), title: 'New tab', icon: Plus, hidden: true, load: () => import('./NewTabPage') });
  setNewTabOpener((to) => openInNewTab(to));
  installTabGestures();

  // Browsers keep Ctrl-T, Ctrl-W and Ctrl-Tab for themselves, so the defaults add Alt; the desktop
  // app and an installed app window may rebind them (Settings, Hotkeys). Mod-Shift-T reaches the
  // page in the desktop app; in a browser tab it reopens the browser's own tab.
  registerCommand({ id: 'tabs.new', name: 'New tab', hotkey: 'Mod-Alt-t', globalHotkey: true, icon: Plus, run: newTab });
  registerCommand({ id: 'tabs.close', name: 'Close tab', hotkey: 'Mod-Alt-w', globalHotkey: true, icon: X, run: closeActiveTab });
  registerCommand({ id: 'tabs.reopen', name: 'Reopen closed tab', hotkey: 'Mod-Shift-t', globalHotkey: true, icon: RotateCcw, when: () => workspace().closed.length > 0, run: reopenClosedTab });
  registerCommand({ id: 'tabs.next', name: 'Go to next tab', hotkey: 'Mod-Alt-PageDown', globalHotkey: true, run: () => cycleTab(1) });
  registerCommand({ id: 'tabs.previous', name: 'Go to previous tab', hotkey: 'Mod-Alt-PageUp', globalHotkey: true, run: () => cycleTab(-1) });
  registerCommand({
    id: 'tabs.pin',
    name: 'Pin or unpin tab',
    icon: Pin,
    run: () => {
      const ws = workspace();
      togglePinTab(ws.activePane, activeTab(ws).id);
    },
  });
  registerCommand({
    id: 'tabs.duplicate',
    name: 'Open current file in new tab',
    icon: CopyPlus,
    when: (c) => c.activePath !== null,
    run: (c) => openInNewTab(noteRoute(c.activePath!)),
  });
  registerCommand({ id: 'tabs.switcher', name: 'Show open tabs', icon: PanelTop, when: phone, run: () => useUi.getState().setOverlay(TAB_SWITCHER) });
  registerCommand({ id: 'panes.splitRight', name: 'Split right', icon: Columns2, when: () => !phone(), run: () => splitActive('right') });
  registerCommand({ id: 'panes.splitDown', name: 'Split down', icon: Rows2, when: () => !phone(), run: () => splitActive('down') });
  registerCommand({ id: 'panes.close', name: 'Close pane', when: many, run: () => closePaneById(workspace().activePane) });
  registerCommand({ id: 'panes.next', name: 'Focus next pane', hotkey: 'Mod-Alt-]', globalHotkey: true, when: many, run: () => focusNextPane(1) });
  registerCommand({ id: 'panes.previous', name: 'Focus previous pane', hotkey: 'Mod-Alt-[', globalHotkey: true, when: many, run: () => focusNextPane(-1) });
}

