// The workspace (ROADMAP item 11, DESIGN §6.40): panes laid out by the split tree, each with a tab
// strip and THE scroll container of its shown tab. Panes are a flat list positioned from the
// layout's geometry, keyed by id, so a split, a resize or a closed neighbour never remounts one.
// Only each pane's shown tab is mounted; other tabs mount when they are shown. Phones keep one
// pane (the active one) without a strip; their tabs are in the tab switcher.
import { useContext, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPath, UNSAFE_NavigationContext, type Location, type Navigator, type To } from 'react-router';
import { AppRoutes } from '../AppRoutes';
import { useBreakpoint } from '../components/layout/useBreakpoint';
import { WorkspaceScroll } from '../components/layout/WorkspaceScroll';
import { layoutGeometry, dragDivider, dropZone, type Divider, type Rect } from './geometry';
import { activeTabOf, splitRoute, type Pane, type Tab } from './model';
import { PaneContext } from './PaneContext';
import { focusPaneById, moveTabTo, navigateInPane, resizeSplit, splitPane, useWorkspace } from './store';
import { readDraggedTab, TAB_MIME } from './tabActions';
import { TabStrip } from './TabStrip';

function tabLocation(tab: Tab): Location {
  const { pathname, search, hash } = splitRoute(tab.route);
  return { pathname, search, hash, state: null, key: `${tab.id}.${tab.nav ?? 0}` };
}

function toRoute(to: To): string {
  return typeof to === 'string' ? to : createPath(to);
}

/** An inactive pane navigates its own tab, never the URL (which shows the active pane). */
function paneNavigator(base: Navigator, pane: string, tab: string): Navigator {
  return {
    ...base,
    push: (to) => navigateInPane(pane, tab, toRoute(to), 'push'),
    replace: (to) => navigateInPane(pane, tab, toRoute(to), 'replace'),
    go: () => undefined,
  };
}

type Zone = 'left' | 'right' | 'up' | 'down' | 'center';

function PaneView({ pane, active, strip, rect, many }: { pane: Pane; active: boolean; strip: boolean; rect: Rect; many: boolean }) {
  const tab = activeTabOf(pane);
  const location = useMemo(() => tabLocation(tab), [tab]);
  const nav = useContext(UNSAFE_NavigationContext);
  const navValue = useMemo(() => (active ? nav : { ...nav, navigator: paneNavigator(nav.navigator, pane.id, tab.id) }), [active, nav, pane.id, tab.id]);
  const paneInfo = useMemo(() => ({ paneId: pane.id, active }), [pane.id, active]);
  const [zone, setZone] = useState<Zone | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const zoneAt = (e: DragEvent): Zone => {
    const r = body.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return 'center';
    return dropZone((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const z = zoneAt(e);
    if (z !== zone) setZone(z);
  };
  const onDrop = (e: DragEvent) => {
    const dragged = readDraggedTab(e);
    setZone(null);
    if (!dragged) return;
    e.preventDefault();
    const z = zoneAt(e);
    if (z === 'center') moveTabTo(dragged.pane, dragged.tab, pane.id);
    else splitPane(pane.id, z, dragged);
  };

  const style: CSSProperties = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
  return (
    <section
      className={`ws-pane${active ? ' is-active' : ''}${many ? ' is-split' : ''}${rect.x > 0 ? ' has-left' : ''}${rect.y > 0 ? ' has-top' : ''}`}
      style={style}
      aria-label={many ? 'Pane' : undefined}
      onPointerDownCapture={() => {
        if (!active) focusPaneById(pane.id);
      }}
      onFocusCapture={() => {
        if (!active) focusPaneById(pane.id);
      }}
    >
      {strip && <TabStrip pane={pane} active={active} />}
      <div ref={body} className="ws-pane-body" onDragOver={onDragOver} onDragLeave={() => setZone(null)} onDrop={onDrop}>
        <PaneContext.Provider value={paneInfo}>
          <UNSAFE_NavigationContext.Provider value={navValue}>
            <WorkspaceScroll pathname={location.pathname} scrollKey={tab.id} active={active}>
              <AppRoutes location={location} active={active} />
            </WorkspaceScroll>
          </UNSAFE_NavigationContext.Provider>
        </PaneContext.Provider>
        {zone && <div className={`ws-drop-zone is-${zone}`} aria-hidden />}
      </div>
    </section>
  );
}

function DividerHandle({ divider, container }: { divider: Divider; container: RefObject<HTMLDivElement | null> }) {
  const row = divider.dir === 'row';
  const style: CSSProperties = row
    ? { left: `${divider.at * 100}%`, top: `${divider.parent.y * 100}%`, height: `${divider.parent.h * 100}%` }
    : { top: `${divider.at * 100}%`, left: `${divider.parent.x * 100}%`, width: `${divider.parent.w * 100}%` };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add(row ? 'is-resizing' : 'is-resizing-rows');
    const move = (ev: PointerEvent) => {
      const abs = row ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      const local = row ? (abs - divider.parent.x) / divider.parent.w : (abs - divider.parent.y) / divider.parent.h;
      resizeSplit(divider.split, dragDivider(divider.sizes, divider.index, local));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing', 'is-resizing-rows');
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 0.02;
    const before = row ? 'ArrowLeft' : 'ArrowUp';
    const after = row ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== before && e.key !== after) return;
    e.preventDefault();
    const start = divider.sizes.slice(0, divider.index).reduce((a, b) => a + b, 0);
    resizeSplit(divider.split, dragDivider(divider.sizes, divider.index, start + (e.key === after ? step : -step)));
  };
  return (
    <div
      className={`ws-divider is-${row ? 'row' : 'column'}`}
      style={style}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      aria-valuenow={Math.round(divider.sizes.slice(0, divider.index).reduce((a, b) => a + b, 0) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export function WorkspaceLayout() {
  const ws = useWorkspace((s) => s.ws);
  const phone = useBreakpoint() === 'phone';
  const container = useRef<HTMLDivElement>(null);
  const geometry = useMemo(() => layoutGeometry(ws.layout), [ws.layout]);
  if (phone) {
    const pane = ws.panes[ws.activePane];
    return (
      <div className="ws-layout">
        <PaneView key={pane.id} pane={pane} active strip={false} rect={FULL} many={false} />
      </div>
    );
  }
  // Creation order, not layout order: moving a pane's DOM node would reload its frames and drop focus.
  const ids = Object.keys(ws.panes).filter((id) => geometry.panes[id]);
  const many = ids.length > 1;
  return (
    <div ref={container} className="ws-layout">
      {ids.map((id) => (
        <PaneView key={id} pane={ws.panes[id]} active={id === ws.activePane} strip rect={geometry.panes[id]} many={many} />
      ))}
      {geometry.dividers.map((d) => (
        <DividerHandle key={`${d.split}.${d.index}`} divider={d} container={container} />
      ))}
    </div>
  );
}
