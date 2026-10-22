'use strict';
// The server address (docs/DESKTOP.md): what the first-run page accepts and how it is checked.
// Pure functions; main.js passes Electron's `net.fetch` to `checkServer`.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for hosts whose plain-http pages are still a secure context (the service worker needs one). */
function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith('.localhost');
}

/**
 * Turns what the user typed into the server's origin, or explains why it can't be used.
 * `notes.tail1234.ts.net` becomes `https://notes.tail1234.ts.net`. Paths, queries and fragments are
 * dropped: the app always lives at the root of its origin. Plain http is allowed only for this computer
 * (local development): over the tailnet it would not be a secure context, so offline mode would not work.
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the address of your NotesApp server.' };
  if (raw.length > 2048) return { ok: false, error: 'That address is too long.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That is not a valid address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The address must start with https://.' };
  }
  if (url.username || url.password) return { ok: false, error: 'The address must not contain a user name or password.' };
  if (!url.hostname) return { ok: false, error: 'That is not a valid address.' };
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: 'Use https:// (Tailscale serves your NotesApp over HTTPS, e.g. https://notes.<tailnet>.ts.net).' };
  }
  return { ok: true, origin: url.origin };
}

function describeNetworkError(e) {
  const msg = String((e && (e.message || e.code)) || e || '');
  if (/CERT|SSL|TLS/i.test(msg)) return `The server's HTTPS certificate was not accepted (${msg}).`;
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(msg)) return "Can't find that server. Is Tailscale connected, and is the name right?";
  if (/TIMED_OUT|timeout|abort/i.test(msg)) return "The server didn't answer in time. Is Tailscale connected?";
  return "Can't reach the server. Is Tailscale connected?";
}

/**
 * Checks that `origin` is a NotesApp server that admits this computer: its web app manifest answers
 * (the same Host and identity checks as every other request, DESIGN §5.13) and names NotesApp.
 * @param {string} origin
 * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
 * @returns {Promise<{ ok: true } | { ok: false, error: string, reachable: boolean }>}
 */
async function checkServer(origin, fetchImpl, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${origin}/manifest.webmanifest`, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
  } catch (e) {
    return { ok: false, reachable: false, error: describeNetworkError(e) };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 421) {
    return { ok: false, reachable: true, error: "The server doesn't answer to this host name. Add it to NOTES_ALLOWED_HOSTS on the server." };
  }
  if (res.status === 403) {
    return { ok: false, reachable: true, error: "The server doesn't allow this computer's Tailscale login (NOTES_IDENTITY_ALLOWED_LOGINS)." };
  }
  if (!res.ok) return { ok: false, reachable: true, error: `The server answered with an error (HTTP ${res.status}).` };
  let manifest = null;
  try {
    manifest = await res.json();
  } catch {
    // Not JSON: not a NotesApp server.
  }
  if (!manifest || typeof manifest.name !== 'string' || !/notesapp/i.test(manifest.name)) {
    return { ok: false, reachable: true, error: "That server answers, but it isn't NotesApp." };
  }
  return { ok: true };
}

module.exports = { normalizeServerUrl, checkServer, isLoopbackHost, describeNetworkError };
