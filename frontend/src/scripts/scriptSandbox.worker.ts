// Scripts in notes (ROADMAP item 40, DESIGN §6.42): the sandbox worker. Scripts run in QuickJS
// (sandbox.ts), which gives them nothing of this worker; the worker itself is locked down as a
// second layer: its own CSP (SecurityHeadersFilter: no fetch, sockets or workers) and, before
// anything runs, the network, storage and messaging globals removed. It talks only to the page
// that started it.
import { runInSandbox } from './sandbox';
import type { FromWorker, ToWorker } from './protocol';

interface SandboxScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
}

const scope = self as unknown as SandboxScope;
const post = scope.postMessage.bind(scope);

for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'FileReaderSync', 'cookieStore']) {
  try {
    Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false });
  } catch {
    // Not present in this browser.
  }
}

let replies = new Map<number, (json: string) => void>();
let running: number | null = null;

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'reply') {
    if (m.id !== running) return;
    const resolve = replies.get(m.call);
    replies.delete(m.call);
    resolve?.(typeof m.json === 'string' ? m.json : JSON.stringify({ e: 'Bad reply' }));
    return;
  }
  if (m.type !== 'run' || running !== null || typeof m.code !== 'string' || typeof m.path !== 'string' || typeof m.now !== 'number') return;
  const id = m.id;
  running = id;
  replies = new Map();
  let call = 0;
  void runInSandbox({ code: m.code, path: m.path, now: m.now }, (name, args) => {
    const n = ++call;
    return new Promise<string>((resolve) => {
      replies.set(n, resolve);
      post({ type: 'call', id, call: n, name, args } satisfies FromWorker);
    });
  }).then((result) => {
    running = null;
    post({ type: 'done', id, output: result.output, error: result.error } satisfies FromWorker);
  });
};
