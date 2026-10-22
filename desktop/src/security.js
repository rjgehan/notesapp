'use strict';
// The shell's security decisions (ROADMAP item 41, docs/DESKTOP.md), as pure functions so they are tested
// without Electron. main.js wires them to every web contents and to the session.

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function originOf(url) {
  const u = parse(url);
  return u && u.origin !== 'null' ? u.origin : null;
}

/** True when `url` is on the configured server's origin (scheme, host and port). */
function isServerUrl(url, serverOrigin) {
  return !!serverOrigin && originOf(url) === serverOrigin;
}

/**
 * Where a navigation or new window may go:
 * - `allow`: the server's own pages, in the app;
 * - `external`: an ordinary web or mail link, handed to the default browser or mail app;
 * - `block`: anything else (file:, javascript:, data:, custom schemes, …).
 */
function classifyNavigation(url, serverOrigin) {
  if (isServerUrl(url, serverOrigin)) return 'allow';
  const u = parse(url);
  if (u && EXTERNAL_PROTOCOLS.has(u.protocol)) return 'external';
  return 'block';
}

/**
 * The permission requests the server's pages may make; everything else is denied.
 * - notifications: the desktop reminder route (ROADMAP item 9);
 * - clipboard-sanitized-write: the app's "Copy" buttons (navigator.clipboard.writeText);
 * - media, microphone only: voice notes and dictation (getUserMedia({ audio: true }));
 * - fullscreen: videos and the drawing view.
 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

function allowPermissionRequest(permission, requestingUrl, serverOrigin, details = {}) {
  if (!isServerUrl(requestingUrl, serverOrigin)) return false;
  if (ALLOWED_PERMISSIONS.has(permission)) return true;
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    return types.length > 0 && types.every((t) => t === 'audio');
  }
  return false;
}

/** The synchronous permission checks (`Notification.permission`, `navigator.permissions.query`). */
function allowPermissionCheck(permission, requestingOrigin, serverOrigin, details = {}) {
  // Electron passes the origin with or without a trailing slash, depending on the check.
  if (!serverOrigin || originOf(requestingOrigin) !== serverOrigin) return false;
  if (ALLOWED_PERMISSIONS.has(permission)) return true;
  if (permission === 'media') return details.mediaType === 'audio';
  return false;
}

/**
 * IPC messages are accepted only from the frames that should send them: the server's pages
 * (`app`), or the shell's own setup and offline pages (`shell`), loaded from the package.
 */
function isTrustedSender(frameUrl, kind, serverOrigin, shellPagesUrl) {
  if (typeof frameUrl !== 'string') return false;
  if (kind === 'app') return isServerUrl(frameUrl, serverOrigin);
  if (kind === 'shell') {
    const u = parse(frameUrl);
    if (!u || u.protocol !== 'file:' || !shellPagesUrl) return false;
    // File paths are case-insensitive on Windows and (by default) macOS.
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase().startsWith(shellPagesUrl.toLowerCase());
  }
  return false;
}

/** The secure renderer settings every window and popup gets. */
function secureWebPreferences(preload, extraArgs = []) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    additionalArguments: extraArgs,
  };
}

module.exports = {
  classifyNavigation,
  isServerUrl,
  allowPermissionRequest,
  allowPermissionCheck,
  isTrustedSender,
  secureWebPreferences,
};
