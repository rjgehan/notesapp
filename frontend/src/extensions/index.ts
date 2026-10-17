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
  /** Route under /x/, e.g. 'tasks/today'. */
  route: string;
  title: string;
  icon: LucideIcon;
  load(): Promise<{ default: ComponentType }>;
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

export type EventHandler = (data: unknown, eventId: string) => void;

const pages: PageDescriptor[] = [];
const panels: PanelDescriptor[] = [];
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
 * Adds a route under /x/, a ribbon and drawer entry, and a palette command. The command closes the
 * phone drawer first, as every built-in navigation does, since navigating keeps open overlays open.
 */
export function registerPage(p: PageDescriptor): void {
  const i = pages.findIndex((x) => x.route === p.route);
  if (i >= 0) pages.splice(i, 1, p);
  else pages.push(p);
  registerCommand({
    id: `page.${p.route}`,
    name: `Open ${p.title}`,
    icon: p.icon,
    run: () => {
      useUi.getState().setDrawerOpen(false);
      navigateTo(pageRoute(p));
    },
  });
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

export function registeredPages(): readonly PageDescriptor[] {
  return pages;
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
