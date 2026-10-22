// A pane's tab strip (DESIGN §6.38): click to show, middle click or × to close, drag to reorder,
// to another pane's strip, or onto a pane's edge to split it; a context menu for the rest.
import { Columns2, Pin, Plus, Rows2, X } from 'lucide-react';
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTree } from '../api/hooks';
import { openContextMenu } from '../components/overlays/openContextMenu';
import { tabLabel } from './labels';
import { readDraggedTab, tabMenu, TAB_MIME } from './tabActions';
import { NEW_TAB_ROUTE, type Pane, type Tab } from './model';
import { closePaneById, closeTabById, moveTabTo, openInNewTab, selectTabById, splitPane, useWorkspace } from './store';

function TabButton({ pane, tab, active, paneActive, onDropAt }: { pane: Pane; tab: Tab; active: boolean; paneActive: boolean; onDropAt(index: number, e: DragEvent): void }) {
  const tree = useTree().data;
  const label = tabLabel(tab.route, tree);
  const Icon = label.icon;
  const panes = useWorkspace((s) => Object.keys(s.ws.panes).length);
  const closed = useWorkspace((s) => s.ws.closed.length);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const index = pane.tabs.indexOf(tab);

  const side = (e: DragEvent<HTMLDivElement>): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
  };
  const menu = (x: number, y: number) => openContextMenu({ x, y }, `Tab ${label.title}`, tabMenu(pane, tab, panes, closed));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectTabById(pane.id, tab.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      closeTabById(pane.id, tab.id);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const sibling = (e.key === 'ArrowRight' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      if (sibling?.getAttribute('role') === 'tab') sibling.focus();
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`ws-tab${active ? ' is-active' : ''}${paneActive && active ? ' is-focused' : ''}${tab.pinned ? ' is-pinned' : ''}${label.missing ? ' is-missing' : ''}${drop ? ` drop-${drop}` : ''}`}
      title={label.title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_MIME, JSON.stringify({ pane: pane.id, tab: tab.id }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setDrop(side(e));
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        const where = side(e);
        setDrop(null);
        onDropAt(where === 'before' ? index : index + 1, e);
      }}
      onClick={() => selectTabById(pane.id, tab.id)}
      onAuxClick={(e: MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        closeTabById(pane.id, tab.id);
      }}
      onMouseDown={(e) => {
        // No autoscroll on middle click.
        if (e.button === 1) e.preventDefault();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
      onKeyDown={onKeyDown}
    >
      <Icon size={14} className="ws-tab-icon" aria-hidden />
      <span className="ws-tab-title">{label.title}</span>
      {tab.pinned ? (
        <Pin size={12} className="ws-tab-pin" aria-label="Pinned" />
      ) : (
        <button
          type="button"
          className="ws-tab-close"
          tabIndex={-1}
          aria-label={`Close ${label.title}`}
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            closeTabById(pane.id, tab.id);
          }}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function TabStrip({ pane, active }: { pane: Pane; active: boolean }) {
  const panes = useWorkspace((s) => Object.keys(s.ws.panes).length);
  const dropAt = (index: number, e: DragEvent) => {
    const dragged = readDraggedTab(e);
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    moveTabTo(dragged.pane, dragged.tab, pane.id, index);
  };
  return (
    <div
      className="ws-tab-bar"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_MIME)) return;
        e.preventDefault();
      }}
      onDrop={(e) => dropAt(pane.tabs.length, e)}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) openInNewTab(NEW_TAB_ROUTE, { pane: pane.id });
      }}
    >
      <div className="ws-tabs" role="tablist" aria-label="Tabs">
        {pane.tabs.map((tab) => (
          <TabButton key={tab.id} pane={pane} tab={tab} active={tab.id === pane.active} paneActive={active} onDropAt={dropAt} />
        ))}
      </div>
      <button type="button" className="icon-button ws-tab-new" aria-label="New tab" title="New tab" onClick={() => openInNewTab(NEW_TAB_ROUTE, { pane: pane.id })}>
        <Plus size={15} aria-hidden />
      </button>
      <div className="ws-tab-actions">
        <button type="button" className="icon-button" aria-label="Split right" title="Split right" onClick={() => splitPane(pane.id, 'right')}>
          <Columns2 size={15} aria-hidden />
        </button>
        <button type="button" className="icon-button" aria-label="Split down" title="Split down" onClick={() => splitPane(pane.id, 'down')}>
          <Rows2 size={15} aria-hidden />
        </button>
        {panes > 1 && (
          <button type="button" className="icon-button" aria-label="Close pane" title="Close pane" onClick={() => closePaneById(pane.id)}>
            <X size={15} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
