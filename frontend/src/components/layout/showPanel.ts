import { useUi } from '../../state/ui';
import { currentBreakpoint } from './useBreakpoint';

/** Shows or hides a sidebar: the desktop column, or the drawer and sheet overlays elsewhere. */
export function toggleSidebar(side: 'left' | 'right'): void {
  const ui = useUi.getState();
  const desktop = currentBreakpoint() === 'desktop';
  if (side === 'left') {
    if (desktop) ui.toggleLeft();
    else ui.setDrawerOpen(!ui.drawerOpen);
  } else if (desktop) ui.toggleRight();
  else ui.setSheetOpen(!ui.sheetOpen);
}

/** Opens a sidebar panel tab, on phones in the drawer or bottom sheet. */
export function showPanel(side: 'left' | 'right', id: string): void {
  const ui = useUi.getState();
  const bp = currentBreakpoint();
  if (side === 'left') {
    ui.setLeftTab(id);
    if (bp === 'desktop') ui.setLeftOpen(true);
    else ui.setDrawerOpen(true);
  } else {
    ui.setRightTab(id);
    if (bp === 'desktop') ui.setRightOpen(true);
    else ui.setSheetOpen(true);
  }
}
