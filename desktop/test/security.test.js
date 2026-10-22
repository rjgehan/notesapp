'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyNavigation, isServerUrl, allowPermissionRequest, allowPermissionCheck, isTrustedSender, secureWebPreferences } = require('../src/security');

const ORIGIN = 'https://notes.tail1234.ts.net';

test('navigation stays on the server origin', () => {
  assert.equal(classifyNavigation(`${ORIGIN}/n/Inbox.md`, ORIGIN), 'allow');
  assert.equal(classifyNavigation(`${ORIGIN}/capture?text=x`, ORIGIN), 'allow');
  // Same host, other scheme or port: another origin.
  assert.equal(classifyNavigation('http://notes.tail1234.ts.net/', ORIGIN), 'external');
  assert.equal(classifyNavigation('https://notes.tail1234.ts.net:8443/', ORIGIN), 'external');
  // Look-alikes.
  assert.equal(classifyNavigation('https://notes.tail1234.ts.net.evil.example/', ORIGIN), 'external');
  assert.equal(classifyNavigation(`https://evil.example/?u=${ORIGIN}`, ORIGIN), 'external');
});

test('other web and mail links go to the system; everything else is blocked', () => {
  assert.equal(classifyNavigation('https://example.com/page', ORIGIN), 'external');
  assert.equal(classifyNavigation('mailto:someone@example.com', ORIGIN), 'external');
  for (const url of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'smb://host/share', 'ms-settings:', 'about:blank', 'not a url', '']) {
    assert.equal(classifyNavigation(url, ORIGIN), 'block', url);
  }
  // Without a configured server nothing is "allow".
  assert.equal(classifyNavigation(`${ORIGIN}/`, null), 'external');
  assert.equal(isServerUrl(`${ORIGIN}/`, null), false);
});

test('permission requests: only a few, only from the server', () => {
  assert.equal(allowPermissionRequest('notifications', `${ORIGIN}/`, ORIGIN), true);
  assert.equal(allowPermissionRequest('clipboard-sanitized-write', `${ORIGIN}/n/a.md`, ORIGIN), true);
  assert.equal(allowPermissionRequest('fullscreen', `${ORIGIN}/`, ORIGIN), true);
  assert.equal(allowPermissionRequest('media', `${ORIGIN}/`, ORIGIN, { mediaTypes: ['audio'] }), true);
  assert.equal(allowPermissionRequest('media', `${ORIGIN}/`, ORIGIN, { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(allowPermissionRequest('media', `${ORIGIN}/`, ORIGIN, { mediaTypes: [] }), false);
  assert.equal(allowPermissionRequest('media', `${ORIGIN}/`, ORIGIN), false);
  for (const p of ['geolocation', 'clipboard-read', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'display-capture', 'hid', 'serial', 'usb', 'idle-detection', 'unknown']) {
    assert.equal(allowPermissionRequest(p, `${ORIGIN}/`, ORIGIN), false, p);
  }
  assert.equal(allowPermissionRequest('notifications', 'https://evil.example/', ORIGIN), false);
  assert.equal(allowPermissionRequest('notifications', 'file:///C:/x.html', ORIGIN), false);
});

test('permission checks mirror the requests', () => {
  assert.equal(allowPermissionCheck('notifications', ORIGIN, ORIGIN), true);
  assert.equal(allowPermissionCheck('notifications', `${ORIGIN}/`, ORIGIN), true);
  assert.equal(allowPermissionCheck('notifications', undefined, ORIGIN), false);
  assert.equal(allowPermissionCheck('notifications', 'https://evil.example', ORIGIN), false);
  assert.equal(allowPermissionCheck('media', ORIGIN, ORIGIN, { mediaType: 'audio' }), true);
  assert.equal(allowPermissionCheck('media', ORIGIN, ORIGIN, { mediaType: 'video' }), false);
  assert.equal(allowPermissionCheck('geolocation', ORIGIN, ORIGIN), false);
  assert.equal(allowPermissionCheck('notifications', ORIGIN, null), false);
});

test('IPC senders', () => {
  const pages = 'file:///C:/Program%20Files/NotesApp/resources/app.asar/src/pages/';
  assert.equal(isTrustedSender(`${ORIGIN}/n/a.md`, 'app', ORIGIN, pages), true);
  assert.equal(isTrustedSender('https://evil.example/', 'app', ORIGIN, pages), false);
  assert.equal(isTrustedSender(`${pages}setup.html`, 'app', ORIGIN, pages), false);
  assert.equal(isTrustedSender(`${pages}setup.html`, 'shell', ORIGIN, pages), true);
  assert.equal(isTrustedSender(`${pages.replace('C:', 'c:')}offline.html?x=1`, 'shell', ORIGIN, pages), true);
  assert.equal(isTrustedSender('file:///C:/Users/me/Downloads/evil.html', 'shell', ORIGIN, pages), false);
  assert.equal(isTrustedSender(`${ORIGIN}/`, 'shell', ORIGIN, pages), false);
  assert.equal(isTrustedSender(undefined, 'app', ORIGIN, pages), false);
  assert.equal(isTrustedSender(`${ORIGIN}/`, 'other', ORIGIN, pages), false);
});

test('every window is sandboxed and isolated', () => {
  const p = secureWebPreferences('/x/preload.js', ['--a=b']);
  assert.equal(p.contextIsolation, true);
  assert.equal(p.sandbox, true);
  assert.equal(p.nodeIntegration, false);
  assert.equal(p.nodeIntegrationInSubFrames, false);
  assert.equal(p.webSecurity, true);
  assert.equal(p.allowRunningInsecureContent, false);
  assert.equal(p.webviewTag, false);
  assert.equal(p.preload, '/x/preload.js');
  assert.deepEqual(p.additionalArguments, ['--a=b']);
});
