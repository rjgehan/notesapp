'use strict';
// The only bridge between web pages and the shell (ROADMAP item 41). It runs sandboxed, with context
// isolation, and exposes two small APIs:
// - `window.notesDesktop` on the server's pages (frontend/src/desktop/bridge.ts): notifications, the
//   capture window, connection state for the title, and commands from the tray;
// - `window.notesShell` on the shell's own setup and offline pages (src/pages/).
// main.js checks the sender of every message, so a page cannot use the other's API.
const { contextBridge, ipcRenderer } = require('electron');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('notesShell', {
    getState: () => ipcRenderer.invoke('shell:get-state'),
    submit: (form) =>
      ipcRenderer.invoke('shell:submit', {
        serverUrl: text(form && form.serverUrl, 2048) ?? '',
        captureHotkey: text(form && form.captureHotkey, 64) ?? '',
        launchAtLogin: !!(form && form.launchAtLogin),
        skipCheck: !!(form && form.skipCheck),
      }),
    retry: () => ipcRenderer.send('shell:retry'),
    openSetup: () => ipcRenderer.send('shell:open-setup'),
    cancelSetup: () => ipcRenderer.send('shell:cancel-setup'),
  });
} else {
  contextBridge.exposeInMainWorld('notesDesktop', {
    version: arg('notes-desktop-version'),
    platform: process.platform,
    isCaptureWindow: arg('notes-window') === 'capture',
    notify: (n) =>
      ipcRenderer.send('app:notify', {
        title: text(n && n.title, 200) ?? 'NotesApp',
        body: text(n && n.body, 1000),
        path: text(n && n.path, 4096),
      }),
    setConnection: (state) => ipcRenderer.send('app:connection', text(state, 32)),
    closeCapture: () => ipcRenderer.send('app:close-capture'),
    focusWindow: () => ipcRenderer.send('app:focus'),
    onCommand: (fn) => {
      const listener = (_event, cmd) => fn(cmd);
      ipcRenderer.on('app:command', listener);
      return () => ipcRenderer.removeListener('app:command', listener);
    },
  });
}
