import { afterEach, describe, expect, it } from 'vitest';
import { noteServerAnswer, noteTransientFailure, reportStreamHealth, resetConnectionState } from './connection';
import { useUi } from './ui';

const connection = () => useUi.getState().connection;

afterEach(() => {
  resetConnectionState();
});

describe('connection indicator (DESIGN §6.18)', () => {
  it('follows the stream: Live, Reconnecting', () => {
    reportStreamHealth('reconnecting');
    expect(connection()).toBe('reconnecting');
    reportStreamHealth('live');
    expect(connection()).toBe('live');
  });

  it('turns Offline after three consecutive transient failures, until the server answers', () => {
    noteTransientFailure();
    noteTransientFailure();
    expect(connection()).toBe('live');
    noteTransientFailure();
    expect(connection()).toBe('offline');
    noteServerAnswer();
    expect(connection()).toBe('live');
  });

  it('clears the failures when the stream reconnects', () => {
    reportStreamHealth('reconnecting');
    for (let i = 0; i < 3; i++) noteTransientFailure();
    expect(connection()).toBe('offline');
    reportStreamHealth('live');
    expect(connection()).toBe('live');
  });
});
