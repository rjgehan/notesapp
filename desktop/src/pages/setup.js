'use strict';
// The first-run and Settings page (docs/DESKTOP.md). It talks to main.js only through window.notesShell.
(async () => {
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const error = $('error');
  const save = $('save');
  const skip = $('skip');

  const state = await window.notesShell.getState();
  if (!state) return;
  $('serverUrl').value = state.serverUrl || '';
  $('captureHotkey').value = state.captureHotkey || '';
  $('launchAtLogin').checked = !!state.launchAtLogin;
  $('version').textContent = `NotesApp desktop ${state.version}`;
  if (!state.firstRun) {
    $('heading').textContent = 'Settings';
    save.textContent = 'Save';
  }
  $('serverUrl').focus();

  function showError(message, field) {
    error.textContent = message;
    error.hidden = !message;
    if (field) $(field).focus();
  }

  async function submit(skipCheck) {
    showError('');
    save.disabled = true;
    skip.disabled = true;
    save.textContent = skipCheck ? save.textContent : 'Checking…';
    try {
      const result = await window.notesShell.submit({
        serverUrl: $('serverUrl').value,
        captureHotkey: $('captureHotkey').value,
        launchAtLogin: $('launchAtLogin').checked,
        skipCheck,
      });
      if (!result.ok) {
        showError(result.error, result.field);
        // Unreachable (Tailscale off?): the address can still be saved and tried later.
        skip.hidden = !result.canSkip;
      }
    } finally {
      save.disabled = false;
      skip.disabled = false;
      save.textContent = state.firstRun ? 'Connect' : 'Save';
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit(false);
  });
  skip.addEventListener('click', () => void submit(true));
  $('cancel').addEventListener('click', () => window.notesShell.cancelSetup());
  $('serverUrl').addEventListener('input', () => {
    skip.hidden = true;
  });
})();
