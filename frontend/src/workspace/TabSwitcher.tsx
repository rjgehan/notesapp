// The phone's tab switcher (DESIGN §6.38, §6.16): phones show one pane, so every tab of every pane
// is listed in a bottom sheet, to switch to, close, or add.
import { Pin, Plus, X } from 'lucide-react';
import { useCallback } from 'react';
import { useTree } from '../api/hooks';
import { Overlay } from '../components/layout/Drawer';
import { useUi } from '../state/ui';
import { tabLabel } from './labels';
import { allTabs, NEW_TAB_ROUTE, pathOfRoute } from './model';
import { closeTabById, openInNewTab, selectTabById, useWorkspace } from './store';

export const TAB_SWITCHER = 'tabs';

export function TabSwitcher() {
  const open = useUi((s) => s.overlay === TAB_SWITCHER);
  const close = useCallback(() => useUi.getState().setOverlay(null), []);
  const ws = useWorkspace((s) => s.ws);
  const tree = useTree().data;
  const tabs = allTabs(ws);
  const current = ws.panes[ws.activePane].active;
  return (
    <Overlay open={open} onClose={close} side="bottom" label="Tabs">
      <div className="ws-switcher">
        <div className="ws-switcher-head">
          <h2>{tabs.length === 1 ? '1 tab' : `${tabs.length} tabs`}</h2>
          <button
            type="button"
            className="button"
            onClick={() => {
              close();
              openInNewTab(NEW_TAB_ROUTE);
            }}
          >
            <Plus size={16} aria-hidden /> New tab
          </button>
        </div>
        <ul className="ws-switcher-list">
          {tabs.map(({ pane, tab }) => {
            const label = tabLabel(tab.route, tree);
            const Icon = label.icon;
            const path = pathOfRoute(tab.route);
            return (
              <li key={tab.id} className={`ws-switcher-row${tab.id === current ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="ws-switcher-open"
                  aria-current={tab.id === current ? 'page' : undefined}
                  onClick={() => {
                    close();
                    selectTabById(pane.id, tab.id);
                  }}
                >
                  <Icon size={18} aria-hidden />
                  <span className="ws-switcher-text">
                    <span className="ws-switcher-title">{label.title}</span>
                    {path && path.includes('/') && <span className="ws-switcher-folder">{path.slice(0, path.lastIndexOf('/'))}</span>}
                  </span>
                  {tab.pinned && <Pin size={14} aria-label="Pinned" />}
                </button>
                <button type="button" className="icon-button" aria-label={`Close ${label.title}`} title="Close tab" onClick={() => closeTabById(pane.id, tab.id, true)}>
                  <X size={18} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Overlay>
  );
}
