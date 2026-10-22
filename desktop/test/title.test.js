'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowTitle, isConnectionState } = require('../src/title');

test('the title shows the connection state', () => {
  assert.equal(windowTitle('Inbox · Notes', 'live'), 'Inbox · Notes');
  assert.equal(windowTitle('Inbox · Notes', 'reconnecting'), 'Inbox · Notes — Reconnecting…');
  assert.equal(windowTitle('Inbox · Notes', 'offline'), 'Inbox · Notes — Offline');
  assert.equal(windowTitle('', 'offline'), 'NotesApp — Offline');
  assert.equal(windowTitle(undefined, 'weird'), 'NotesApp');
});

test('connection states', () => {
  assert.equal(isConnectionState('live'), true);
  assert.equal(isConnectionState('reconnecting'), true);
  assert.equal(isConnectionState('offline'), true);
  assert.equal(isConnectionState('online'), false);
  assert.equal(isConnectionState(undefined), false);
});
