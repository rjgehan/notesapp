// Extension points (DESIGN §6.8). Every v1 view, panel and command is registered through these
// same functions (builtins.ts), which proves the APIs before the first extension needs them.
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { useSyncExternalStore } from 'react';
import { registerCommand } from '../features/commands';
import { navigateTo } from '../features/navigation';
import { useUi } from '../state/ui';

export { registerView, viewFor, registeredViews, type EmbedProps, type FileViewDescriptor, type FileViewProps } from '../views/registry';
export { registerCommand, type Command, type CommandContext } from '../features/commands';

export interface PageDescriptor {
  /** Route under /x/, e.g. 'tasks/today'; it may hold react-router params ('tasks/list/:id'). */
  route: string;
  title: string;
  icon: LucideIcon;
  load(): Promise<{ default: ComponentType }>;
  /**
   * A route only: no ribbon, drawer or palette entry. For pages reached from another page, such
   * as one task list (`tasks/list/:id`), whose route cannot be opened without its params.
   */
  hidden?: boolean;
}

export interface PanelDescriptor {
  id: string;
  side: 'left' | 'right';
  title: string;
  icon: LucideIcon;
  load(): Promise<{ default: ComponentType<{ activePath: string | null }> }>;
  /**
   * The component itself, for panels bundled eagerly: a panel whose input must take focus inside
   * the gesture that showed it (the search field, DESIGN §6.13) cannot wait for a lazy chunk.
   */
  component?: ComponentType<{ activePath: string | null }>;
}

/**
 * A component the shell mounts once, for dialogs that belong to no page or panel (a feature's
 * quick-add dialog, a detail sheet opened from anywhere). It renders nothing while closed, keeps
 * its own open state, and must stay small: it lazy-loads its heavy parts itself. It is eager so
 * that a dialog opened by a key press or a tap can focus its input inside that gesture (iOS).
 */
export interface OverlayDescriptor {
  id: string;
  component: ComponentType;
}

export type EventHandler = (data: unknown, eventId: string) => void;

const pages: PageDescriptor[] = [];
const panels: PanelDescriptor[] = [];
const overlays: OverlayDescriptor[] = [];
const eventHandlers = new Map<string, EventHandler[]>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const l of listeners) l();
}

/** The route of a registered page. */
export function pageRoute(p: Pick<PageDescriptor, 'route'>): string {
  return '/x/' + p.route;
}

/**
 * Adds a route under /x/ and, unless the page is hidden, a ribbon and drawer entry and a palette
 * command. The command closes the phone drawer first, as every built-in navigation does, since
 * navigating keeps open overlays open.
 */
export function registerPage(p: PageDescriptor): void {
  const i = pages.findIndex((x) => x.route === p.route);
  if (i >= 0) pages.splice(i, 1, p);
  else pages.push(p);
  if (!p.hidden) {
    registerCommand({
      id: `page.${p.route}`,
      name: `Open ${p.title}`,
      icon: p.icon,
      run: () => {
        useUi.getState().setDrawerOpen(false);
        navigateTo(pageRoute(p));
      },
    });
  }
  changed();
}

/** Mounts a dialog host in the shell (see OverlayDescriptor). */
export function registerOverlay(o: OverlayDescriptor): void {
  const i = overlays.findIndex((x) => x.id === o.id);
  if (i >= 0) overlays.splice(i, 1, o);
  else overlays.push(o);
  changed();
}

/** Adds a sidebar tab (phone: drawer tab or bottom-sheet tab). */
export function registerPanel(p: PanelDescriptor): void {
  const i = panels.findIndex((x) => x.id === p.id);
  if (i >= 0) panels.splice(i, 1, p);
  else panels.push(p);
  changed();
}

/**
 * Handles an SSE event name. The event stream adds a listener for every registered name, on the
 * current EventSource and on every future one.
 */
export function registerEventHandler(name: string, fn: EventHandler): void {
  const list = eventHandlers.get(name) ?? [];
  list.push(fn);
  eventHandlers.set(name, list);
  changed();
}

/** Every page, hidden ones included (the routes). */
export function registeredPages(): readonly PageDescriptor[] {
  return pages;
}

/** The pages that get a ribbon and a drawer entry. */
export function menuPages(): PageDescriptor[] {
  return pages.filter((p) => !p.hidden);
}

export function registeredOverlays(): readonly OverlayDescriptor[] {
  return overlays;
}

export function registeredPanels(side: 'left' | 'right'): PanelDescriptor[] {
  return panels.filter((p) => p.side === side);
}

export function eventHandlerNames(): string[] {
  return [...eventHandlers.keys()];
}

export function dispatchExtensionEvent(name: string, data: unknown, eventId: string): void {
  for (const fn of eventHandlers.get(name) ?? []) {
    try {
      fn(data, eventId);
    } catch (e) {
      console.error(`[notesapp] event handler for ${name} failed`, e);
    }
  }
}

export function onExtensionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders when pages, panels or event handlers are registered. */
export function useExtensionsVersion(): number {
  return useSyncExternalStore(onExtensionsChanged, () => version);
}
