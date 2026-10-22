'use strict';
// The shell's own settings (docs/DESKTOP.md), a small JSON file in the app's user-data folder
// (%APPDATA%\NotesApp on Windows, ~/Library/Application Support/NotesApp on macOS). No tokens or
// passwords: the server knows this computer by its Tailscale identity.
const fs = require('node:fs');
const path = require('node:path');
const { normalizeServerUrl } = require('./serverUrl');

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';

function defaults() {
  return { serverUrl: null, captureHotkey: DEFAULT_HOTKEY, launchAtLogin: false, window: null };
}

/** A plausible Electron accelerator: modifiers and one key, joined by `+`. */
function isAccelerator(s) {
  if (typeof s !== 'string' || s.length > 64) return false;
  const parts = s.split('+');
  if (parts.length < 2 || parts.some((p) => p.length === 0)) return false;
  const modifiers = /^(Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)$/i;
  const key = parts[parts.length - 1];
  return parts.slice(0, -1).every((p) => modifiers.test(p)) && /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Return|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Escape|Esc|Plus|[`~!@#$%^&*()\-_=[\]{};:'",.<>/?\\|])$/i.test(key);
}

/** Merges what was stored over the defaults, dropping anything malformed. */
function sanitize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.serverUrl === 'string') {
    const n = normalizeServerUrl(raw.serverUrl);
    if (n.ok) out.serverUrl = n.origin;
  }
  if (isAccelerator(raw.captureHotkey) || raw.captureHotkey === '') out.captureHotkey = raw.captureHotkey;
  if (typeof raw.launchAtLogin === 'boolean') out.launchAtLogin = raw.launchAtLogin;
  if (raw.window && typeof raw.window === 'object') out.window = raw.window;
  return out;
}

function load(file) {
  try {
    // A file edited by hand on Windows may start with a byte-order mark.
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  } catch {
    return defaults();
  }
}

/** Written to a temporary file first, so a crash mid-write never leaves half a file. */
function save(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitize(settings), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { load, save, sanitize, defaults, isAccelerator, DEFAULT_HOTKEY };
