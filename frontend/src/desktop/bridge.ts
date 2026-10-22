// The desktop app's bridge (ROADMAP item 41, DESIGN §6.38). The Electron shell in `desktop/` loads this
// web app from the server and its preload script exposes `window.notesDesktop`; in a browser it is
// absent and nothing here does anything. The shell sends a few commands (tray menu, notification
// clicks, resume after sleep) and the page reports its connection state for the window title.
import { eventStream } from '../sync/liveSync';
import { navigateTo } from '../features/navigation';
import { useUi, type ConnectionState } from '../state/ui';

export type DesktopCommand =
  /** Tray › Open today's note. */
  | { type: 'open-today' }
  /** An in-app path (`/n/…`), e.g. from a notification click or the capture window's "Open the note". */
  | { type: 'navigate'; to: string }
  /** The computer woke up or the network changed: reconnect the event stream now. */
  | { type: 'resume' };

export interface DesktopNotification {
  title: string;
  body?: string;
  /** An in-app path opened when the notification is clicked. */
  path?: string;
}

/** What the preload script exposes (desktop/src/preload.js). */
export interface NotesDesktop {
  /** The shell's version (not the web app's build). */
  version: string;
  platform: string;
  /** This page is the small quick-capture window. */
  isCaptureWindow: boolean;
  notify(n: DesktopNotification): void;
  setConnection(state: ConnectionState): void;
  closeCapture(): void;
  /** Shows and focuses the main window, also when it was closed to the tray. */
  focusWindow(): void;
  onCommand(fn: (cmd: DesktopCommand) => void): () => void;
}

declare global {
  interface Window {
    notesDesktop?: NotesDesktop;
  }
}

export function desktop(): NotesDesktop | null {
  return (typeof window !== 'undefined' && window.notesDesktop) || null;
}

/** True for an in-app path the shell may navigate to: absolute, same origin, never `//host`. */
export function isAppPath(to: unknown): to is string {
  return typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') && to.length < 4096;
}

export interface BridgeActions {
  openToday(): Promise<unknown>;
  navigate(to: string): void;
  reconnect(): void;
}

export function handleCommand(cmd: DesktopCommand, actions: BridgeActions): void {
  switch (cmd?.type) {
    case 'open-today':
      void actions.openToday().catch((e: unknown) => console.error('[notesapp] daily note failed', e));
      return;
    case 'navigate':
      if (isAppPath(cmd.to)) actions.navigate(cmd.to);
      return;
    case 'resume':
      actions.reconnect();
      return;
  }
}

const defaultActions: BridgeActions = {
  // Loaded on first use, like the rest of the daily-note code paths.
  openToday: () => import('../features/daily').then((m) => m.openTodaysDailyNote()),
  navigate: (to) => navigateTo(to),
  reconnect: () => eventStream.reconnect(),
};

/** Wires the bridge up when the page runs inside the desktop app; returns a cleanup. */
export function installDesktopBridge(bridge: NotesDesktop | null = desktop(), actions: BridgeActions = defaultActions): () => void {
  if (!bridge || bridge.isCaptureWindow) return () => undefined;
  const off = bridge.onCommand((cmd) => handleCommand(cmd, actions));
  bridge.setConnection(useUi.getState().connection);
  const unsubscribe = useUi.subscribe((s, prev) => {
    if (s.connection !== prev.connection) bridge.setConnection(s.connection);
  });
  // Notification click handlers (reminders, ROADMAP item 9) call window.focus(); in the desktop app
  // that also brings the window back from the tray, which the page alone cannot do.
  const originalFocus = window.focus;
  window.focus = function focus(this: Window) {
    bridge.focusWindow();
    originalFocus.call(window);
  };
  return () => {
    off();
    unsubscribe();
    window.focus = originalFocus;
  };
}
