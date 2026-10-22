// The workspace store (ROADMAP item 11, DESIGN §6.40): the model of model.ts in zustand, saved per
// device in localStorage, and kept in step with the URL. The URL is the source of truth for the
// active pane: every change here that shows another route in the active pane navigates there
// (switching tabs or panes replaces the entry, a new tab pushes one), and every navigation of the
// router lands in the active tab (RouteSync).
import { create } from 'zustand';
import { useFocusRequests } from '../features/focus';
import { navigateTo } from '../features/navigation';
import { takeNewTabGesture } from './gesture';
import { appPathname, vaultKey } from '../state/vault';
import {
  activeTab,
  adoptUrl,
  closeMany,
  closePane,
  closeTab,
  createWorkspace,
  focusAdjacentPane,
  focusPane,
  HISTORY_LIMIT,
  moveTab,
  navigate,
  NEW_TAB_ROUTE,
  openTab,
  pop,
  rebase,
  reopenClosed,
  resize,
  routeOf,
  sanitize,
  selectAdjacentTab,
  selectTab,
  split,
  togglePin,
  type NavKind,
  type OpenOptions,
  type SplitSide,
  type Workspace,
} from './model';

export const WORKSPACE_KEY = 'notesapp:workspace';

/** Routes outside the workspace: quick capture and the web clipper's hand-over have pages of their own. */
function outsideWorkspace(pathname: string): boolean {
  return pathname === '/capture' || pathname === '/clip';
}

function currentRoute(): string {
  return routeOf({ pathname: appPathname(), search: window.location.search, hash: window.location.hash });
}

export function loadWorkspace(): Workspace {
  let saved: Workspace | null;
  try {
    const raw = localStorage.getItem(vaultKey(WORKSPACE_KEY));
    saved = raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    saved = null;
  }
  if (outsideWorkspace(appPathname())) return saved ?? createWorkspace('/');
  // A deep link, a bookmark or a reload shows its route in the active pane.
  return saved ? adoptUrl(saved, currentRoute()) : createWorkspace(currentRoute());
}

interface WorkspaceState {
  ws: Workspace;
}

export const useWorkspace = create<WorkspaceState>()(() => ({ ws: loadWorkspace() }));

export function workspace(): Workspace {
  return useWorkspace.getState().ws;
}

// ---------- persistence ----------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function trimmed(ws: Workspace): Workspace {
  const panes: Workspace['panes'] = {};
  for (const [id, p] of Object.entries(ws.panes)) {
    panes[id] = { ...p, tabs: p.tabs.map((t) => ({ ...t, back: t.back.slice(-HISTORY_LIMIT), forward: t.forward.slice(0, HISTORY_LIMIT) })) };
  }
  return { ...ws, panes };
}

export function saveWorkspaceNow(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(vaultKey(WORKSPACE_KEY), JSON.stringify(trimmed(workspace())));
  } catch {
    // Storage full or blocked: the layout is simply not remembered.
  }
}

useWorkspace.subscribe(() => {
  if (saveTimer === null) saveTimer = setTimeout(saveWorkspaceNow, 250);
});

if (typeof window !== 'undefined') window.addEventListener('pagehide', saveWorkspaceNow);

// ---------- changes ----------

function set(ws: Workspace): void {
  if (ws !== workspace()) useWorkspace.setState({ ws });
}

/**
 * Applies a change and brings the URL to the active tab's route: `push` for a new tab (so Back
 * returns to the tab it came from), `replace` otherwise.
 */
function apply(change: (ws: Workspace) => Workspace, how: NavKind = 'replace'): void {
  // The click that asked for this was handled here; navigateTo must not open yet another tab.
  takeNewTabGesture();
  set(change(workspace()));
  const route = activeTab(workspace()).route;
  if (route !== currentRoute()) navigateTo(route, how === 'replace' ? { replace: true } : undefined);
}

export function openInNewTab(route: string, opts: OpenOptions = {}): void {
  apply((ws) => openTab(ws, route, opts), opts.background ? 'replace' : 'push');
}

export function newTab(): void {
  openInNewTab(NEW_TAB_ROUTE);
}

export function selectTabById(pane: string, tab: string): void {
  apply((ws) => selectTab(ws, pane, tab));
}

export function cycleTab(delta: number): void {
  apply((ws) => selectAdjacentTab(ws, delta));
}

export function closeTabById(pane: string, tab: string, force = false): void {
  apply((ws) => closeTab(ws, pane, tab, force));
}

export function closeActiveTab(): void {
  const ws = workspace();
  closeTabById(ws.activePane, activeTab(ws).id);
}

export function closeOtherTabs(pane: string, tab: string, which: 'others' | 'right'): void {
  apply((ws) => closeMany(ws, pane, tab, which));
}

export function reopenClosedTab(): void {
  apply(reopenClosed, 'push');
}

export function togglePinTab(pane: string, tab: string): void {
  apply((ws) => togglePin(ws, pane, tab));
}

export function moveTabTo(fromPane: string, tab: string, toPane: string, index?: number): void {
  apply((ws) => moveTab(ws, fromPane, tab, toPane, index));
}

export function splitPane(pane: string, side: SplitSide, move?: { pane: string; tab: string }): void {
  apply((ws) => split(ws, pane, side, move));
}

export function splitActive(side: SplitSide): void {
  splitPane(workspace().activePane, side);
}

export function closePaneById(pane: string): void {
  apply((ws) => closePane(ws, pane));
}

export function focusPaneById(pane: string): void {
  apply((ws) => focusPane(ws, pane));
}

/** Keyboard pane switching: the newly active pane's scroll container takes the focus. */
export function focusNextPane(delta: number): void {
  apply((ws) => focusAdjacentPane(ws, delta));
  useFocusRequests.setState((s) => ({ workspace: s.workspace + 1 }));
}

export function resizeSplit(splitId: string, sizes: number[]): void {
  set(resize(workspace(), splitId, sizes));
}

/** A file or folder moved: tabs follow it. The active route is re-routed by the move handling itself. */
export function rebaseWorkspace(from: string, to: string, type: 'file' | 'folder'): void {
  set(rebase(workspace(), from, to, type));
}

/** A navigation inside an inactive pane (its own router context, DESIGN §6.40). */
export function navigateInPane(pane: string, tab: string, route: string, kind: NavKind): void {
  set(navigate(workspace(), route, kind, { pane, tab }));
}

// ---------- the router's side (RouteSync) ----------

let lastIdx: number | null = null;

function historyIdx(): number {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' ? state.idx : 0;
}

/**
 * The router moved to `route`. A push or replace lands in the active tab; browser back and forward
 * walk the active tab's own history, and the URL is corrected when the browser's entry belongs to
 * another tab.
 */
export function routerNavigated(route: string, action: string): void {
  const idx = historyIdx();
  const previous = lastIdx ?? idx;
  lastIdx = idx;
  const ws = workspace();
  if (action !== 'POP') {
    set(navigate(ws, route, action === 'PUSH' ? 'push' : 'replace'));
    return;
  }
  if (activeTab(ws).route === route) return;
  const result = pop(ws, route, idx < previous ? 'back' : 'forward');
  set(result.ws);
  if (result.url !== null) navigateTo(result.url, { replace: true });
}

/** Test seam: start over from `ws`. */
export function resetWorkspace(ws: Workspace = createWorkspace(currentRoute())): void {
  lastIdx = null;
  useWorkspace.setState({ ws });
}
