import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../state/ui';
import { handleCommand, installDesktopBridge, isAppPath, type BridgeActions, type DesktopCommand, type NotesDesktop } from './bridge';

function actions() {
  return {
    openToday: vi.fn<BridgeActions['openToday']>(() => Promise.resolve(true)),
    navigate: vi.fn<BridgeActions['navigate']>(),
    reconnect: vi.fn<BridgeActions['reconnect']>(),
  };
}

function fakeShell(over: Partial<NotesDesktop> = {}) {
  let listener: ((cmd: DesktopCommand) => void) | null = null;
  const shell: NotesDesktop = {
    version: '1.0.0',
    platform: 'win32',
    isCaptureWindow: false,
    notify: vi.fn(),
    setConnection: vi.fn(),
    closeCapture: vi.fn(),
    focusWindow: vi.fn(),
    onCommand: vi.fn((fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    }),
    ...over,
  };
  return { shell, send: (cmd: DesktopCommand) => listener?.(cmd), listening: () => listener !== null };
}

afterEach(() => useUi.getState().setConnection('live'));

describe('isAppPath', () => {
  it('accepts in-app absolute paths only', () => {
    expect(isAppPath('/n/Daily/2026-10-21.md')).toBe(true);
    expect(isAppPath('/')).toBe(true);
    expect(isAppPath('//evil.example/x')).toBe(false);
    expect(isAppPath('/\\evil.example')).toBe(false);
    expect(isAppPath('https://evil.example/')).toBe(false);
    expect(isAppPath('n/relative')).toBe(false);
    expect(isAppPath(42)).toBe(false);
  });
});

describe('handleCommand', () => {
  it('opens today’s note, navigates to app paths and reconnects on resume', () => {
    const a = actions();
    handleCommand({ type: 'open-today' }, a);
    handleCommand({ type: 'navigate', to: '/n/Inbox.md' }, a);
    handleCommand({ type: 'resume' }, a);
    expect(a.openToday).toHaveBeenCalledTimes(1);
    expect(a.navigate).toHaveBeenCalledWith('/n/Inbox.md');
    expect(a.reconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores foreign navigation targets and unknown commands', () => {
    const a = actions();
    handleCommand({ type: 'navigate', to: 'https://example.com/' }, a);
    handleCommand({ type: 'navigate', to: '//example.com/' }, a);
    handleCommand({ type: 'nope' } as unknown as DesktopCommand, a);
    expect(a.navigate).not.toHaveBeenCalled();
    expect(a.openToday).not.toHaveBeenCalled();
    expect(a.reconnect).not.toHaveBeenCalled();
  });
});

describe('installDesktopBridge', () => {
  it('does nothing in a browser', () => {
    expect(() => installDesktopBridge(null, actions())()).not.toThrow();
  });

  it('routes commands and reports connection changes until cleaned up', () => {
    const { shell, send, listening } = fakeShell();
    const a = actions();
    const cleanup = installDesktopBridge(shell, a);
    expect(shell.setConnection).toHaveBeenLastCalledWith('live');
    send({ type: 'navigate', to: '/n/A.md' });
    expect(a.navigate).toHaveBeenCalledWith('/n/A.md');
    useUi.getState().setConnection('offline');
    expect(shell.setConnection).toHaveBeenLastCalledWith('offline');
    cleanup();
    expect(listening()).toBe(false);
    useUi.getState().setConnection('reconnecting');
    expect(shell.setConnection).toHaveBeenCalledTimes(2);
  });

  it('brings the window back from the tray when the page calls window.focus()', () => {
    const { shell } = fakeShell();
    const original = window.focus;
    const cleanup = installDesktopBridge(shell, actions());
    window.focus();
    expect(shell.focusWindow).toHaveBeenCalledTimes(1);
    cleanup();
    expect(window.focus).toBe(original);
    window.focus();
    expect(shell.focusWindow).toHaveBeenCalledTimes(1);
  });

  it('leaves the capture window alone', () => {
    const { shell } = fakeShell({ isCaptureWindow: true });
    installDesktopBridge(shell, actions());
    expect(shell.onCommand).not.toHaveBeenCalled();
    expect(shell.setConnection).not.toHaveBeenCalled();
  });
});
