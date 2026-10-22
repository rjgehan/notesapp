'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeServerUrl, checkServer, isLoopbackHost } = require('../src/serverUrl');

test('adds https:// and keeps only the origin', () => {
  assert.deepEqual(normalizeServerUrl('notes.tail1234.ts.net'), { ok: true, origin: 'https://notes.tail1234.ts.net' });
  assert.deepEqual(normalizeServerUrl('  https://Notes.Tail1234.ts.net/n/Inbox.md?x=1#y '), { ok: true, origin: 'https://notes.tail1234.ts.net' });
  assert.deepEqual(normalizeServerUrl('https://notes.tail1234.ts.net:8443'), { ok: true, origin: 'https://notes.tail1234.ts.net:8443' });
});

test('allows plain http only on this computer', () => {
  assert.deepEqual(normalizeServerUrl('http://127.0.0.1:5175'), { ok: true, origin: 'http://127.0.0.1:5175' });
  assert.deepEqual(normalizeServerUrl('http://localhost:18330'), { ok: true, origin: 'http://localhost:18330' });
  assert.equal(normalizeServerUrl('http://app.localhost:5175').ok, true);
  assert.equal(normalizeServerUrl('http://[::1]:5175').ok, true);
  const r = normalizeServerUrl('http://notes.tail1234.ts.net');
  assert.equal(r.ok, false);
  assert.match(r.error, /https/);
  assert.equal(normalizeServerUrl('http://100.101.102.103').ok, false);
});

test('rejects other schemes, credentials and junk', () => {
  for (const bad of ['', '   ', 'file:///C:/x', 'javascript:alert(1)', 'ftp://example.com', 'https://user:pw@notes.example', 'https://', 'http://exa mple.com']) {
    assert.equal(normalizeServerUrl(bad).ok, false, bad);
  }
  assert.equal(normalizeServerUrl('x'.repeat(3000)).ok, false);
});

test('loopback hosts', () => {
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('foo.localhost'), true);
  assert.equal(isLoopbackHost('localhost.example.com'), false);
});

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

test('checkServer accepts a NotesApp manifest and asks for it without following redirects', async () => {
  let seen;
  const r = await checkServer('https://notes.example', async (url, init) => {
    seen = { url, init };
    return response(200, { name: 'NotesApp', short_name: 'Notes' });
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.url, 'https://notes.example/manifest.webmanifest');
  assert.equal(seen.init.redirect, 'error');
});

test('checkServer explains each failure', async () => {
  const offline = await checkServer('https://notes.example', async () => {
    throw new Error('net::ERR_NAME_NOT_RESOLVED');
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.reachable, false);
  assert.match(offline.error, /Tailscale/);

  const refused = await checkServer('https://notes.example', async () => {
    throw new Error('net::ERR_CONNECTION_REFUSED');
  });
  assert.match(refused.error, /Is Tailscale connected/);

  const cert = await checkServer('https://notes.example', async () => {
    throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
  });
  assert.match(cert.error, /certificate/);

  const host = await checkServer('https://notes.example', async () => response(421, {}));
  assert.equal(host.reachable, true);
  assert.match(host.error, /NOTES_ALLOWED_HOSTS/);

  const identity = await checkServer('https://notes.example', async () => response(403, {}));
  assert.match(identity.error, /Tailscale login/);

  const broken = await checkServer('https://notes.example', async () => response(502, {}));
  assert.match(broken.error, /HTTP 502/);

  const other = await checkServer('https://notes.example', async () => response(200, { name: 'Something else' }));
  assert.match(other.error, /isn't NotesApp/);

  const html = await checkServer('https://notes.example', async () => response(200, '<html>'));
  assert.match(html.error, /isn't NotesApp/);
});

test('checkServer times out', async () => {
  const r = await checkServer(
    'https://notes.example',
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      }),
    20,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /in time/);
});
