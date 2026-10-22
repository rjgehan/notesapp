// The workspace model of ROADMAP item 11 (DESIGN §6.40): panes in a split layout, each with tabs,
// each tab with its own route and back/forward history. Pure functions over plain data, so the
// store (store.ts) only persists and wires them, and every rule is unit-tested.
import { noteRoute, pathFromLocation, rebasePath } from '../features/paths';

/** Where a new, empty tab starts (a hidden page registered in register.ts). */
export const NEW_TAB_ROUTE = '/x/new-tab';
/** History kept per tab, each way. */
export const HISTORY_LIMIT = 50;
/** Closed tabs remembered for Reopen closed tab. */
export const CLOSED_LIMIT = 20;

export interface Tab {
  id: string;
  /** pathname + search + hash, exactly as the URL shows it when this tab is active. */
  route: string;
  pinned?: boolean;
  /** Earlier routes of this tab, oldest first. */
  back: string[];
  /** Routes gone back from, nearest first. */
  forward: string[];
  /** Counts the navigations of this tab: the key of its location, so following a link again scrolls again. */
  nav?: number;
}

export interface Pane {
  id: string;
  tabs: Tab[];
  /** The id of the shown tab. */
  active: string;
}

export type SplitDir = 'row' | 'column';

export type Layout = { type: 'pane'; id: string } | { type: 'split'; id: string; dir: SplitDir; children: Layout[]; sizes: number[] };

export interface ClosedTab {
  tab: Tab;
  pane: string;
  index: number;
}

export interface Workspace {
  panes: Record<string, Pane>;
  layout: Layout;
  activePane: string;
  closed: ClosedTab[];
}

let counter = 0;
export function newId(prefix: string): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function newTab(route: string): Tab {
  return { id: newId('t'), route, back: [], forward: [] };
}

function newPane(tab: Tab): Pane {
  return { id: newId('p'), tabs: [tab], active: tab.id };
}

export function createWorkspace(route: string): Workspace {
  const pane = newPane(newTab(route));
  return { panes: { [pane.id]: pane }, layout: { type: 'pane', id: pane.id }, activePane: pane.id, closed: [] };
}

// ---------- routes ----------

export function splitRoute(route: string): { pathname: string; search: string; hash: string } {
  const hashAt = route.indexOf('#');
  const beforeHash = hashAt < 0 ? route : route.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : route.slice(hashAt);
  const q = beforeHash.indexOf('?');
  return { pathname: q < 0 ? beforeHash : beforeHash.slice(0, q), search: q < 0 ? '' : beforeHash.slice(q), hash };
}

export function routeOf(location: { pathname: string; search: string; hash: string }): string {
  return location.pathname + location.search + location.hash;
}

/** The vault path a route shows, or null for pages. */
export function pathOfRoute(route: string): string | null {
  return pathFromLocation(splitRoute(route).pathname);
}

// ---------- queries ----------

/** Pane ids in layout order (left to right, top to bottom). */
export function paneOrder(ws: Workspace): string[] {
  const out: string[] = [];
  const walk = (l: Layout) => {
    if (l.type === 'pane') out.push(l.id);
    else l.children.forEach(walk);
  };
  walk(ws.layout);
  return out;
}

export function activePaneOf(ws: Workspace): Pane {
  return ws.panes[ws.activePane];
}

export function activeTabOf(pane: Pane): Tab {
  return pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
}

export function activeTab(ws: Workspace): Tab {
  return activeTabOf(activePaneOf(ws));
}

export function allTabs(ws: Workspace): Array<{ pane: Pane; tab: Tab }> {
  return paneOrder(ws).flatMap((id) => ws.panes[id].tabs.map((tab) => ({ pane: ws.panes[id], tab })));
}

/**
 * The pane that shows `path` for views that cannot share their file between panes (DESIGN §6.40):
 * the active pane when it shows it, else the first pane in layout order whose shown tab does.
 */
export function exclusiveOwner(ws: Workspace, path: string): string | null {
  const shows = (id: string) => pathOfRoute(activeTabOf(ws.panes[id]).route) === path;
  if (shows(ws.activePane)) return ws.activePane;
  return paneOrder(ws).find(shows) ?? null;
}

// ---------- helpers ----------

function cap(list: string[], first: boolean): string[] {
  if (list.length <= HISTORY_LIMIT) return list;
  return first ? list.slice(0, HISTORY_LIMIT) : list.slice(list.length - HISTORY_LIMIT);
}

function updatePane(ws: Workspace, pane: Pane): Workspace {
  return { ...ws, panes: { ...ws.panes, [pane.id]: pane } };
}

function updateTab(ws: Workspace, paneId: string, tab: Tab): Workspace {
  const pane = ws.panes[paneId];
  return updatePane(ws, { ...pane, tabs: pane.tabs.map((t) => (t.id === tab.id ? tab : t)) });
}

function findTab(ws: Workspace, paneId: string, tabId: string): Tab | undefined {
  return ws.panes[paneId]?.tabs.find((t) => t.id === tabId);
}

function samePath(a: string, b: string): boolean {
  return splitRoute(a).pathname === splitRoute(b).pathname;
}

// ---------- navigation ----------

export type NavKind = 'push' | 'replace';

/**
 * A navigation in a tab (the active one by default). A push from a pinned tab to another file or
 * page opens a new tab next to it instead, so the pinned tab keeps its file.
 */
export function navigate(ws: Workspace, route: string, kind: NavKind, target?: { pane: string; tab: string }): Workspace {
  const paneId = target?.pane ?? ws.activePane;
  const pane = ws.panes[paneId];
  if (!pane) return ws;
  const tab = target ? findTab(ws, paneId, target.tab) : activeTabOf(pane);
  if (!tab) return ws;
  // Following a link to where the tab already is: a new navigation all the same (it scrolls again).
  if (tab.route === route) return kind === 'push' ? updateTab(ws, paneId, { ...tab, nav: (tab.nav ?? 0) + 1 }) : ws;
  if (kind === 'push' && tab.pinned && !samePath(tab.route, route)) {
    return openTab(ws, route, { pane: paneId, after: tab.id, background: paneId !== ws.activePane ? true : undefined });
  }
  const nav = (tab.nav ?? 0) + 1;
  if (kind === 'replace') return updateTab(ws, paneId, { ...tab, route, nav });
  return updateTab(ws, paneId, { ...tab, route, nav, back: cap([...tab.back, tab.route], false), forward: [] });
}

/**
 * Browser back or forward landed on `route` (DESIGN §6.40): the active tab walks its own history
 * instead. Returns the workspace and the route the URL must show, when it differs from `route`.
 * With no history that way, a tab of the active pane showing `route` is selected (the tab a
 * Mod-click came from); otherwise the tab stays and the URL is put back.
 */
export function pop(ws: Workspace, route: string, dir: 'back' | 'forward'): { ws: Workspace; url: string | null } {
  const pane = activePaneOf(ws);
  const tab = activeTabOf(pane);
  if (tab.route === route) return { ws, url: null };
  const stack = dir === 'back' ? tab.back : tab.forward;
  if (stack.length > 0) {
    const target = dir === 'back' ? stack[stack.length - 1] : stack[0];
    const next: Tab =
      dir === 'back'
        ? { ...tab, route: target, nav: (tab.nav ?? 0) + 1, back: stack.slice(0, -1), forward: cap([tab.route, ...tab.forward], true) }
        : { ...tab, route: target, nav: (tab.nav ?? 0) + 1, forward: stack.slice(1), back: cap([...tab.back, tab.route], false) };
    return { ws: updateTab(ws, pane.id, next), url: target === route ? null : target };
  }
  const other = pane.tabs.find((t) => t.route === route);
  if (other) return { ws: updatePane(ws, { ...pane, active: other.id }), url: null };
  return { ws, url: tab.route };
}

// ---------- tabs ----------

export interface OpenOptions {
  pane?: string;
  /** Insert after this tab (default: the pane's active tab). */
  after?: string;
  /** Keep the current tab shown. */
  background?: boolean;
}

export function openTab(ws: Workspace, route: string, opts: OpenOptions = {}): Workspace {
  const paneId = opts.pane && ws.panes[opts.pane] ? opts.pane : ws.activePane;
  const pane = ws.panes[paneId];
  const tab = newTab(route);
  const afterId = opts.after ?? pane.active;
  const at = pane.tabs.findIndex((t) => t.id === afterId);
  const tabs = [...pane.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
  const next = updatePane(ws, { ...pane, tabs, active: opts.background ? pane.active : tab.id });
  return opts.background ? next : { ...next, activePane: paneId };
}

export function selectTab(ws: Workspace, paneId: string, tabId: string): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || !pane.tabs.some((t) => t.id === tabId)) return ws;
  if (pane.active === tabId && ws.activePane === paneId) return ws;
  return { ...updatePane(ws, { ...pane, active: tabId }), activePane: paneId };
}

/** The next (1) or previous (-1) tab of the active pane, wrapping around. */
export function selectAdjacentTab(ws: Workspace, delta: number): Workspace {
  const pane = activePaneOf(ws);
  if (pane.tabs.length < 2) return ws;
  const i = pane.tabs.findIndex((t) => t.id === pane.active);
  const next = pane.tabs[(i + delta + pane.tabs.length) % pane.tabs.length];
  return selectTab(ws, pane.id, next.id);
}

/** Focuses the next (1) or previous (-1) pane in layout order. */
export function focusAdjacentPane(ws: Workspace, delta: number): Workspace {
  const order = paneOrder(ws);
  if (order.length < 2) return ws;
  const i = order.indexOf(ws.activePane);
  return focusPane(ws, order[(i + delta + order.length) % order.length]);
}

export function focusPane(ws: Workspace, paneId: string): Workspace {
  if (!ws.panes[paneId] || ws.activePane === paneId) return ws;
  return { ...ws, activePane: paneId };
}

function remember(ws: Workspace, closed: ClosedTab[]): Workspace {
  return { ...ws, closed: [...ws.closed, ...closed].slice(-CLOSED_LIMIT) };
}

/** Removes tabs from a pane without remembering them; an emptied pane closes (or, if it is the last one, gets a new tab). */
function removeTabs(ws: Workspace, paneId: string, ids: Set<string>): Workspace {
  const pane = ws.panes[paneId];
  const tabs = pane.tabs.filter((t) => !ids.has(t.id));
  if (tabs.length === 0) {
    if (Object.keys(ws.panes).length > 1) return removePane(ws, paneId);
    const fresh = newTab(NEW_TAB_ROUTE);
    return updatePane(ws, { ...pane, tabs: [fresh], active: fresh.id });
  }
  let active = pane.active;
  if (ids.has(active)) {
    // The tab to the right of the closed one, else the one to its left.
    const at = pane.tabs.findIndex((t) => t.id === active);
    const right = pane.tabs.slice(at + 1).find((t) => !ids.has(t.id));
    const left = [...pane.tabs.slice(0, at)].reverse().find((t) => !ids.has(t.id));
    active = (right ?? left ?? tabs[0]).id;
  }
  return updatePane(ws, { ...pane, tabs, active });
}

/** Closes a tab; a pinned one only with `force` (its menu's Close), not with the close-tab key. */
export function closeTab(ws: Workspace, paneId: string, tabId: string, force = false): Workspace {
  const pane = ws.panes[paneId];
  const index = pane?.tabs.findIndex((t) => t.id === tabId) ?? -1;
  if (!pane || index < 0) return ws;
  const tab = pane.tabs[index];
  if (tab.pinned && !force) return ws;
  return removeTabs(remember(ws, [{ tab, pane: paneId, index }]), paneId, new Set([tabId]));
}

/** Closes the pane's other unpinned tabs (`'others'`) or those to the right of `tabId`. */
export function closeMany(ws: Workspace, paneId: string, tabId: string, which: 'others' | 'right'): Workspace {
  const pane = ws.panes[paneId];
  if (!pane) return ws;
  const at = pane.tabs.findIndex((t) => t.id === tabId);
  const doomed = pane.tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab, index }) => tab.id !== tabId && !tab.pinned && (which === 'others' || index > at));
  if (doomed.length === 0) return ws;
  const next = remember(
    ws,
    doomed.map(({ tab, index }) => ({ tab, pane: paneId, index })),
  );
  return selectTab(removeTabs(next, paneId, new Set(doomed.map((d) => d.tab.id))), paneId, tabId);
}

export function reopenClosed(ws: Workspace): Workspace {
  const last = ws.closed[ws.closed.length - 1];
  if (!last) return ws;
  const paneId = ws.panes[last.pane] ? last.pane : ws.activePane;
  const pane = ws.panes[paneId];
  const tab = { ...last.tab, id: newId('t') };
  const tabs = [...pane.tabs];
  tabs.splice(Math.min(last.index, tabs.length), 0, tab);
  return { ...updatePane({ ...ws, closed: ws.closed.slice(0, -1) }, { ...pane, tabs, active: tab.id }), activePane: paneId };
}

export function togglePin(ws: Workspace, paneId: string, tabId: string): Workspace {
  const tab = findTab(ws, paneId, tabId);
  if (!tab) return ws;
  return updateTab(ws, paneId, { ...tab, pinned: !tab.pinned || undefined });
}

/** Moves a tab within its pane or to another pane, before position `index` (end when omitted). */
export function moveTab(ws: Workspace, fromPane: string, tabId: string, toPane: string, index?: number): Workspace {
  const source = ws.panes[fromPane];
  const target = ws.panes[toPane];
  const tab = source?.tabs.find((t) => t.id === tabId);
  if (!tab || !target) return ws;
  if (fromPane === toPane) {
    const from = source.tabs.indexOf(tab);
    const tabs = source.tabs.filter((t) => t !== tab);
    let to = index ?? tabs.length + 1;
    if (to > from) to--;
    tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
    return { ...updatePane(ws, { ...source, tabs, active: tab.id }), activePane: toPane };
  }
  const tabs = [...target.tabs];
  tabs.splice(Math.max(0, Math.min(index ?? tabs.length, tabs.length)), 0, tab);
  const placed = updatePane(ws, { ...target, tabs, active: tab.id });
  return { ...removeTabs(placed, fromPane, new Set([tabId])), activePane: toPane };
}

// ---------- splits ----------

export type SplitSide = 'left' | 'right' | 'up' | 'down';

function mapLayout(l: Layout, fn: (l: Layout) => Layout): Layout {
  const mapped = fn(l);
  if (mapped !== l || mapped.type === 'pane') return mapped;
  return { ...mapped, children: mapped.children.map((c) => mapLayout(c, fn)) };
}

/**
 * Splits `paneId`, putting a new pane on `side`. The new pane gets the tab `move` (dragged from
 * another place) or, by default, a new tab showing what the split pane shows.
 */
export function split(ws: Workspace, paneId: string, side: SplitSide, move?: { pane: string; tab: string }): Workspace {
  const pane = ws.panes[paneId];
  if (!pane) return ws;
  let moved: Tab | undefined;
  if (move) {
    moved = findTab(ws, move.pane, move.tab);
    if (!moved) return ws;
    // Dragging a pane's only tab to its own edge would leave the pane empty: nothing to do.
    if (move.pane === paneId && pane.tabs.length === 1) return ws;
  }
  const tab = moved ?? { ...newTab(activeTabOf(pane).route) };
  const created = newPane(tab);
  const dir: SplitDir = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'up';
  let sibling = false;
  // The split that directly holds the pane, in the same direction, takes the new pane as a sibling.
  let layout = mapLayout(ws.layout, (l) => {
    if (l.type !== 'split' || l.dir !== dir) return l;
    const i = l.children.findIndex((c) => c.type === 'pane' && c.id === paneId);
    if (i < 0) return l;
    sibling = true;
    const children = [...l.children];
    const sizes = [...l.sizes];
    const half = sizes[i] / 2;
    sizes[i] = half;
    children.splice(before ? i : i + 1, 0, { type: 'pane', id: created.id });
    sizes.splice(before ? i : i + 1, 0, half);
    return { ...l, children, sizes };
  });
  if (!sibling) {
    layout = mapLayout(ws.layout, (l) => {
      if (l.type !== 'pane' || l.id !== paneId) return l;
      const leaf: Layout = { type: 'pane', id: created.id };
      return { type: 'split', id: newId('s'), dir, children: before ? [leaf, l] : [l, leaf], sizes: [0.5, 0.5] };
    });
  }
  let next: Workspace = { ...ws, layout, panes: { ...ws.panes, [created.id]: created }, activePane: created.id };
  if (moved && move) next = { ...removeTabs(next, move.pane, new Set([move.tab])), activePane: created.id };
  return next;
}

/** Removes a pane from the layout; single-child splits collapse into their child. */
function removePane(ws: Workspace, paneId: string): Workspace {
  if (!ws.panes[paneId] || Object.keys(ws.panes).length < 2) return ws;
  const order = paneOrder(ws);
  const prune = (l: Layout): Layout | null => {
    if (l.type === 'pane') return l.id === paneId ? null : l;
    const kept: Layout[] = [];
    const sizes: number[] = [];
    l.children.forEach((c, i) => {
      const p = prune(c);
      if (!p) return;
      // A child split in the same direction merges into this one.
      if (p.type === 'split' && p.dir === l.dir) {
        p.children.forEach((cc, j) => {
          kept.push(cc);
          sizes.push(l.sizes[i] * p.sizes[j]);
        });
      } else {
        kept.push(p);
        sizes.push(l.sizes[i]);
      }
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { ...l, children: kept, sizes: sizes.map((s) => s / total) };
  };
  const layout = prune(ws.layout) ?? { type: 'pane', id: order.find((id) => id !== paneId)! };
  const panes = { ...ws.panes };
  delete panes[paneId];
  let activePane = ws.activePane;
  if (activePane === paneId) {
    const i = order.indexOf(paneId);
    activePane = order[i + 1] ?? order[i - 1];
  }
  return { ...ws, layout, panes, activePane };
}

/** Closes a pane and all its tabs (remembered for Reopen closed tab). */
export function closePane(ws: Workspace, paneId: string): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || Object.keys(ws.panes).length < 2) return ws;
  return removePane(
    remember(
      ws,
      pane.tabs.map((tab, index) => ({ tab, pane: paneId, index })),
    ),
    paneId,
  );
}

export const MIN_PANE_FRACTION = 0.1;

/** New sizes for a split (fractions; normalized, each at least MIN_PANE_FRACTION). */
export function resize(ws: Workspace, splitId: string, sizes: number[]): Workspace {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return ws;
  const normalized = sizes.map((s) => Math.max(MIN_PANE_FRACTION, s / total));
  const sum = normalized.reduce((a, b) => a + b, 0);
  const fixed = normalized.map((s) => s / sum);
  return {
    ...ws,
    layout: mapLayout(ws.layout, (l) => (l.type === 'split' && l.id === splitId && l.sizes.length === fixed.length ? { ...l, sizes: fixed } : l)),
  };
}

// ---------- moves and startup ----------

/** Routes of a moved file or folder follow it, in every tab, its history and the closed tabs. */
export function rebase(ws: Workspace, from: string, to: string, type: 'file' | 'folder'): Workspace {
  let changed = false;
  const map = (route: string): string => {
    const path = pathOfRoute(route);
    if (path === null) return route;
    const next = type === 'file' ? (path === from ? to : null) : rebasePath(path, from, to);
    if (next === null || next === path) return route;
    changed = true;
    const { search, hash } = splitRoute(route);
    return noteRoute(next) + search + hash;
  };
  const tab = (t: Tab): Tab => ({ ...t, route: map(t.route), back: t.back.map(map), forward: t.forward.map(map) });
  const panes: Record<string, Pane> = {};
  for (const [id, p] of Object.entries(ws.panes)) panes[id] = { ...p, tabs: p.tabs.map(tab) };
  const closed = ws.closed.map((c) => ({ ...c, tab: tab(c.tab) }));
  return changed ? { ...ws, panes, closed } : ws;
}

/**
 * The page loads at `route` (DESIGN §6.40: the URL is the source of truth for the active pane).
 * The active tab already showing it, or a tab of the active pane, then of any pane, showing it is
 * selected; otherwise the active tab navigates there.
 */
export function adoptUrl(ws: Workspace, route: string): Workspace {
  if (activeTab(ws).route === route) return ws;
  const inActive = activePaneOf(ws).tabs.find((t) => t.route === route);
  if (inActive) return selectTab(ws, ws.activePane, inActive.id);
  const anywhere = allTabs(ws).find(({ tab }) => tab.route === route);
  if (anywhere) return selectTab(ws, anywhere.pane.id, anywhere.tab.id);
  return navigate(ws, route, 'push');
}

// ---------- persistence ----------

function isTab(t: unknown): t is Tab {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.startsWith('/'));
  return typeof o.id === 'string' && typeof o.route === 'string' && o.route.startsWith('/') && strings(o.back) && strings(o.forward);
}

/** A persisted workspace if it is well-formed, else null (the page then starts with one tab). */
export function sanitize(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!o.panes || typeof o.panes !== 'object' || !o.layout || typeof o.activePane !== 'string') return null;
  const panes: Record<string, Pane> = {};
  for (const [id, p] of Object.entries(o.panes as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') return null;
    const pane = p as Record<string, unknown>;
    if (pane.id !== id || !Array.isArray(pane.tabs) || pane.tabs.length === 0 || !pane.tabs.every(isTab) || typeof pane.active !== 'string') return null;
    const tabs = pane.tabs as Tab[];
    panes[id] = { id, tabs, active: tabs.some((t) => t.id === pane.active) ? (pane.active as string) : tabs[0].id };
  }
  const seen = new Set<string>();
  const valid = (l: unknown): l is Layout => {
    if (!l || typeof l !== 'object') return false;
    const n = l as Record<string, unknown>;
    if (n.type === 'pane') {
      if (typeof n.id !== 'string' || !panes[n.id] || seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    }
    return (
      n.type === 'split' &&
      typeof n.id === 'string' &&
      (n.dir === 'row' || n.dir === 'column') &&
      Array.isArray(n.children) &&
      n.children.length >= 2 &&
      Array.isArray(n.sizes) &&
      n.sizes.length === n.children.length &&
      n.sizes.every((s) => typeof s === 'number' && s > 0) &&
      n.children.every(valid)
    );
  };
  if (!valid(o.layout) || seen.size !== Object.keys(panes).length || !panes[o.activePane]) return null;
  const closed = Array.isArray(o.closed)
    ? (o.closed as unknown[]).filter((c): c is ClosedTab => !!c && typeof c === 'object' && isTab((c as ClosedTab).tab) && typeof (c as ClosedTab).pane === 'string' && typeof (c as ClosedTab).index === 'number')
    : [];
  return { panes, layout: o.layout as Layout, activePane: o.activePane, closed: closed.slice(-CLOSED_LIMIT) };
}
