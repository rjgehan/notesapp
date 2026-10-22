'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, save, sanitize, defaults, isAccelerator, DEFAULT_HOTKEY } = require('../src/settings');

test('defaults: no server, the documented hotkey, no login item', () => {
  assert.deepEqual(defaults(), { serverUrl: null, captureHotkey: DEFAULT_HOTKEY, launchAtLogin: false, window: null });
  assert.equal(DEFAULT_HOTKEY, 'CommandOrControl+Shift+Space');
});

test('accelerators', () => {
  for (const ok of ['CommandOrControl+Shift+Space', 'Ctrl+Alt+N', 'Cmd+Shift+K', 'Alt+F12', 'Control+Shift+.']) assert.equal(isAccelerator(ok), true, ok);
  for (const bad of ['Space', 'Ctrl+', '+K', 'Ctrl+Foo', 'Ctrl+Shift+Space+', 42, null, 'Ctrl+' + 'A'.repeat(70)]) assert.equal(isAccelerator(bad), false, String(bad));
});

test('sanitize drops malformed values and normalizes the server', () => {
  assert.deepEqual(sanitize({ serverUrl: 'notes.example.ts.net/x', captureHotkey: '', launchAtLogin: true, window: { x: 1 } }), {
    serverUrl: 'https://notes.example.ts.net',
    captureHotkey: '',
    launchAtLogin: true,
    window: { x: 1 },
  });
  assert.deepEqual(sanitize({ serverUrl: 'javascript:alert(1)', captureHotkey: 'nope', launchAtLogin: 'yes', window: 3 }), defaults());
  assert.deepEqual(sanitize(null), defaults());
});

test('save then load round-trips; a missing or corrupt file gives the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notesapp-desktop-'));
  try {
    const file = path.join(dir, 'sub', 'settings.json');
    assert.deepEqual(load(file), defaults());
    const s = { ...defaults(), serverUrl: 'https://notes.example.ts.net', launchAtLogin: true };
    save(file, s);
    assert.deepEqual(load(file), s);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
    fs.writeFileSync(file, '﻿' + JSON.stringify(s));
    assert.deepEqual(load(file), s);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(load(file), defaults());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
