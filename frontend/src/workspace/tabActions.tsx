// Tab drag data and the tab context menu (DESIGN §6.40).
import { Columns2, Pin, PinOff, Rows2, X } from 'lucide-react';
import type { DragEvent } from 'react';
import type { MenuEntry } from '../components/overlays/ContextMenu';
import type { Pane, Tab } from './model';
import { closeOtherTabs, closePaneById, closeTabById, reopenClosedTab, splitPane, togglePinTab } from './store';

export const TAB_MIME = 'application/x-notesapp-tab';

export function readDraggedTab(e: DragEvent): { pane: string; tab: string } | null {
  if (!e.dataTransfer.types.includes(TAB_MIME)) return null;
  try {
    const v = JSON.parse(e.dataTransfer.getData(TAB_MIME)) as { pane?: unknown; tab?: unknown };
    return typeof v.pane === 'string' && typeof v.tab === 'string' ? { pane: v.pane, tab: v.tab } : null;
  } catch {
    return null;
  }
}

export function tabMenu(pane: Pane, tab: Tab, panes: number, closed: number): MenuEntry[] {
  const index = pane.tabs.indexOf(tab);
  return [
    { id: 'close', label: 'Close', icon: <X size={16} />, run: () => closeTabById(pane.id, tab.id, true) },
    { id: 'close-others', label: 'Close others', disabled: pane.tabs.length < 2, run: () => closeOtherTabs(pane.id, tab.id, 'others') },
    { id: 'close-right', label: 'Close tabs to the right', disabled: index === pane.tabs.length - 1, run: () => closeOtherTabs(pane.id, tab.id, 'right') },
    'separator',
    tab.pinned
      ? { id: 'unpin', label: 'Unpin', icon: <PinOff size={16} />, run: () => togglePinTab(pane.id, tab.id) }
      : { id: 'pin', label: 'Pin', icon: <Pin size={16} />, run: () => togglePinTab(pane.id, tab.id) },
    { id: 'split-right', label: 'Split right', icon: <Columns2 size={16} />, run: () => splitPane(pane.id, 'right', pane.tabs.length > 1 ? { pane: pane.id, tab: tab.id } : undefined) },
    { id: 'split-down', label: 'Split down', icon: <Rows2 size={16} />, run: () => splitPane(pane.id, 'down', pane.tabs.length > 1 ? { pane: pane.id, tab: tab.id } : undefined) },
    'separator',
    { id: 'reopen', label: 'Reopen closed tab', disabled: closed === 0, run: reopenClosedTab },
    ...(panes > 1 ? [{ id: 'close-pane', label: 'Close pane', run: () => closePaneById(pane.id) } as MenuEntry] : []),
  ];
}
