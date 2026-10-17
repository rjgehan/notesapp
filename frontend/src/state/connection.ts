// Connection indicator state (DESIGN §6.18), derived from three inputs: the event stream's health
// (Live / Reconnecting), consecutive transient API failures, and navigator.onLine.
import { useUi, type ConnectionState } from './ui';

export type StreamHealth = 'live' | 'reconnecting';

/** Three consecutive transient failures turn the indicator red. */
const FAILURES_FOR_OFFLINE = 3;

let stream: StreamHealth = 'live';
let consecutiveFailures = 0;
let online = typeof navigator === 'undefined' || navigator.onLine !== false;

function publish(): void {
  const next: ConnectionState = !online || consecutiveFailures >= FAILURES_FOR_OFFLINE ? 'offline' : stream;
  if (useUi.getState().connection !== next) useUi.getState().setConnection(next);
}

export function reportStreamHealth(health: StreamHealth): void {
  // A stream that (re)connected proves the server is reachable again.
  if (health === 'live' && stream !== 'live') consecutiveFailures = 0;
  stream = health;
  publish();
}

/** A request failed transiently (network, 502/504, busy). */
export function noteTransientFailure(): void {
  consecutiveFailures++;
  publish();
}

/** A request got an answer from the server (success or problem document). */
export function noteServerAnswer(): void {
  if (consecutiveFailures === 0) return;
  consecutiveFailures = 0;
  publish();
}

export function installOnlineListener(): () => void {
  const update = () => {
    online = navigator.onLine !== false;
    publish();
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}

/** Test hook: back to the initial inputs. */
export function resetConnectionState(): void {
  stream = 'live';
  consecutiveFailures = 0;
  online = true;
  publish();
}
