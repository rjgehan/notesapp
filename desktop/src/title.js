'use strict';
// The main window's title shows the connection state (ROADMAP item 41): the page's own title, plus a
// suffix while the live-sync stream is reconnecting or the server is out of reach.

const SUFFIX = {
  live: '',
  reconnecting: ' — Reconnecting…',
  offline: ' — Offline',
};

/**
 * @param {string} pageTitle document.title of the server's page
 * @param {'live' | 'reconnecting' | 'offline'} connection what the page reported (desktop/bridge.ts)
 */
function windowTitle(pageTitle, connection) {
  const base = typeof pageTitle === 'string' && pageTitle.trim() ? pageTitle.trim() : 'NotesApp';
  return base + (SUFFIX[connection] ?? '');
}

function isConnectionState(s) {
  return s === 'live' || s === 'reconnecting' || s === 'offline';
}

module.exports = { windowTitle, isConnectionState };
