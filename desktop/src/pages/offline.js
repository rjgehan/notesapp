'use strict';
// The shell's offline page (docs/DESKTOP.md): shown when the server can't be reached and the app's
// service worker has no cached copy yet. main.js retries on its own; this page offers Retry now.
(async () => {
  const $ = (id) => document.getElementById(id);
  const state = await window.notesShell.getState();
  if (state) {
    $('server').textContent = state.serverUrl || '';
    $('reason').textContent = state.offlineReason ? `(${state.offlineReason})` : '';
  }
  $('retry').addEventListener('click', () => window.notesShell.retry());
  $('settings').addEventListener('click', () => window.notesShell.openSetup());
  // The network came back: try straight away.
  window.addEventListener('online', () => window.notesShell.retry());
  $('retry').focus();
})();
