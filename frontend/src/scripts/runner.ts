// Scripts in notes (ROADMAP item 40, DESIGN §6.39): runs scripts in the sandbox worker, one at a
// time, and answers their API calls on the page. The worker is a dedicated module worker; only it
// can post to this page's handler, and every message is checked anyway: its type, the run it
// belongs to, and the output's shape. A run that does not finish in time gets the worker
// terminated (a new one starts for the next run). Without Worker support (tests), the same
// sandbox runs on the page; QuickJS isolates the script there too.
import { createHost, type HostDeps, type ReadSet } from './host';
import { checkItem, WALL_LIMIT_MS, type FromWorker, type OutputItem, type ScriptError, type ToWorker } from './protocol';

export interface RunResult {
  output: OutputItem[];
  error: ScriptError | null;
  reads: ReadSet;
}

interface Pending {
  id: number;
  call(name: string, args: string): Promise<string>;
  resolve(r: { output: OutputItem[]; error: ScriptError | null }): void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let pending: Pending | null = null;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();

function dropWorker(): void {
  worker?.terminate();
  worker = null;
}

function onMessage(event: MessageEvent<unknown>): void {
  const p = pending;
  const m = event.data as FromWorker | null;
  if (!p || !m || typeof m !== 'object' || m.id !== p.id) return;
  if (m.type === 'call' && typeof m.name === 'string' && typeof m.args === 'string' && Number.isInteger(m.call)) {
    void p.call(m.name, m.args).then((json) => {
      if (pending === p) worker?.postMessage({ type: 'reply', id: p.id, call: m.call, json } satisfies ToWorker);
    });
    return;
  }
  if (m.type === 'done') {
    const output = Array.isArray(m.output) ? m.output.map((i) => checkItem(i)).filter((i): i is OutputItem => i !== null) : [];
    const error = m.error && typeof m.error === 'object' && typeof m.error.message === 'string' ? { message: m.error.message, line: typeof m.error.line === 'number' ? m.error.line : null, kind: m.error.kind } : null;
    finish(p, { output, error });
  }
}

function finish(p: Pending, r: { output: OutputItem[]; error: ScriptError | null }): void {
  if (pending !== p) return;
  clearTimeout(p.timer);
  pending = null;
  p.resolve(r);
}

function sandboxWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./scriptSandbox.worker.ts', import.meta.url), { type: 'module', name: 'script-sandbox' });
  } catch {
    return null;
  }
  worker.onmessage = onMessage;
  worker.onerror = (e) => {
    e.preventDefault?.();
    const p = pending;
    dropWorker();
    if (p) finish(p, { output: [], error: { kind: 'script', line: null, message: 'The script sandbox stopped' } });
  };
  return worker;
}

async function runOnce(code: string, path: string, host: ReturnType<typeof createHost>): Promise<{ output: OutputItem[]; error: ScriptError | null }> {
  const now = new Date();
  const wallNow = now.getTime() - now.getTimezoneOffset() * 60_000;
  const w = sandboxWorker();
  if (!w) {
    const { runInSandbox } = await import('./sandbox');
    return runInSandbox({ code, path, now: wallNow }, host.call);
  }
  return new Promise((resolve) => {
    const id = nextId++;
    const p: Pending = {
      id,
      call: host.call,
      resolve,
      timer: setTimeout(() => {
        // Stuck (or the sandbox never answered): the worker goes, with whatever it was doing.
        dropWorker();
        finish(p, { output: [], error: { kind: 'timeout', line: null, message: 'The script took too long and was stopped' } });
      }, WALL_LIMIT_MS),
    };
    pending = p;
    w.postMessage({ type: 'run', id, code, path, now: wallNow } satisfies ToWorker);
  });
}

/** Runs a script of the note `deps.path`; runs queue behind each other. */
export function runScript(code: string, deps: HostDeps): Promise<RunResult> {
  const host = createHost(deps);
  const run = queue.then(() => runOnce(code, deps.path, host)).then((r) => ({ ...r, reads: host.reads }));
  queue = run.catch(() => {});
  return run;
}

/** Tests: forget the worker. */
export function resetRunnerForTests(): void {
  dropWorker();
  pending = null;
  queue = Promise.resolve();
}
