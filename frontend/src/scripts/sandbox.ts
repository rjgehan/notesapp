// Scripts in notes (ROADMAP item 40, DESIGN §6.39): one run of a script in QuickJS (compiled to
// WebAssembly, `quickjs-emscripten`, the asyncify build). The script sees only the prelude's API;
// QuickJS has no DOM, no network, no timers and no storage of its own, and the host gives it
// nothing else. A fresh runtime per run, with a memory cap, a stack cap, and a CPU budget enforced
// by the interrupt handler (the time its API calls wait for the page does not count). The worker
// (scriptSandbox.worker.ts) runs this; tests run it directly.
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { newQuickJSAsyncWASMModuleFromVariant, type QuickJSAsyncWASMModule, type QuickJSHandle } from 'quickjs-emscripten-core';
import prelude from './guest/prelude.js?raw';
import { CPU_LIMIT_MS, MAX_HOST_CALLS, MAX_OUTPUT_BYTES, MAX_OUTPUT_ITEMS, MEMORY_LIMIT_BYTES, STACK_LIMIT_BYTES, checkItem, type OutputItem, type ScriptError } from './protocol';

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;

function quickjs(): Promise<QuickJSAsyncWASMModule> {
  modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(variant).catch((e: unknown) => {
    modulePromise = null;
    throw e;
  });
  return modulePromise;
}

/** Answers a script's API call: `name` and its arguments' JSON; resolves to `{v}` or `{e}` JSON. */
export type HostCaller = (name: string, args: string) => Promise<string>;

export interface SandboxRun {
  code: string;
  path: string;
  now: number;
}

export interface SandboxResult {
  output: OutputItem[];
  error: ScriptError | null;
}

const HOST_ERROR = 'host-error';

/** The script's line of an error, from QuickJS's stack (`at <eval> (script:3)`). */
function lineOf(stack: unknown): number | null {
  if (typeof stack !== 'string') return null;
  const m = /\(?script:(\d+)(?::\d+)?\)?/.exec(stack);
  return m ? Number(m[1]) : null;
}

class Stop extends Error {
  readonly kind: ScriptError['kind'];
  constructor(kind: ScriptError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Runs one script; never throws (every failure is the result's error). */
export async function runInSandbox(run: SandboxRun, callHost: HostCaller, cpuLimitMs = CPU_LIMIT_MS): Promise<SandboxResult> {
  const output: OutputItem[] = [];
  let bytes = 0;
  let calls = 0;
  const halt: { stop: Stop | null } = { stop: null };
  let module: QuickJSAsyncWASMModule;
  try {
    module = await quickjs();
  } catch (e) {
    return { output, error: { kind: 'script', line: null, message: `The script sandbox could not start: ${e instanceof Error ? e.message : String(e)}` } };
  }
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  // CPU time: the time spent running, not waiting for the page's answers.
  let used = 0;
  let since = performance.now();
  let waiting = false;
  runtime.setInterruptHandler(() => {
    if (waiting) return false;
    if (used + (performance.now() - since) > cpuLimitMs) {
      halt.stop ??= new Stop('timeout', `The script ran longer than ${cpuLimitMs} ms and was stopped`);
      return true;
    }
    return false;
  });
  const context = runtime.newContext();
  const handles: QuickJSHandle[] = [];
  try {
    const hostFn = context.newAsyncifiedFunction('__host', async (nameHandle, argsHandle) => {
      const name = context.getString(nameHandle);
      const args = argsHandle ? context.getString(argsHandle) : 'null';
      if (++calls > MAX_HOST_CALLS) {
        halt.stop ??= new Stop('host', `The script made more than ${MAX_HOST_CALLS} calls`);
        return context.newString(JSON.stringify({ e: halt.stop.message }));
      }
      used += performance.now() - since;
      waiting = true;
      let reply: string;
      try {
        reply = await callHost(name, args);
      } catch (e) {
        reply = JSON.stringify({ e: e instanceof Error ? e.message : HOST_ERROR });
      } finally {
        waiting = false;
        since = performance.now();
      }
      return context.newString(reply);
    });
    const emitFn = context.newFunction('__emit', (jsonHandle) => {
      const json = context.getString(jsonHandle);
      bytes += json.length;
      if (output.length >= MAX_OUTPUT_ITEMS || bytes > MAX_OUTPUT_BYTES) {
        halt.stop ??= new Stop('output', 'The script showed too much; the rest is left out');
        return context.newError(halt.stop.message);
      }
      let item: OutputItem | null = null;
      try {
        item = checkItem(JSON.parse(json));
      } catch {
        item = null;
      }
      if (item) output.push(item);
      return undefined;
    });
    handles.push(hostFn, emitFn);
    context.setProp(context.global, '__host', hostFn);
    context.setProp(context.global, '__emit', emitFn);
    const parsedCtx = context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify({ now: run.now, path: run.path }))})`);
    if (parsedCtx.error) {
      parsedCtx.error.dispose();
      throw new Error('context');
    }
    context.setProp(context.global, '__ctx', parsedCtx.value);
    parsedCtx.value.dispose();
    const setup = await context.evalCodeAsync(prelude, 'prelude');
    if (setup.error) {
      const dumped: unknown = context.dump(setup.error);
      setup.error.dispose();
      throw new Error(`The script API could not start: ${JSON.stringify(dumped)}`);
    }
    setup.value.dispose();
    since = performance.now();
    used = 0;
    const result = await context.evalCodeAsync(run.code, 'script');
    if (result.error) {
      const dumped = context.dump(result.error) as { name?: string; message?: string; stack?: string } | string;
      result.error.dispose();
      if (halt.stop) return { output, error: { kind: halt.stop.kind, line: null, message: halt.stop.message } };
      const message = typeof dumped === 'object' && dumped !== null ? `${dumped.name ?? 'Error'}: ${dumped.message ?? ''}` : String(dumped);
      const kind = /out of memory/i.test(message) ? 'memory' : 'script';
      return { output, error: { kind, line: typeof dumped === 'object' && dumped !== null ? lineOf(dumped.stack) : null, message: kind === 'memory' ? 'The script used more memory than allowed' : message } };
    }
    result.value.dispose();
    return { output, error: halt.stop ? { kind: halt.stop.kind, line: null, message: halt.stop.message } : null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (halt.stop) return { output, error: { kind: halt.stop.kind, line: null, message: halt.stop.message } };
    return { output, error: { kind: /memory/i.test(message) ? 'memory' : 'script', line: null, message } };
  } finally {
    for (const h of handles) if (h.alive) h.dispose();
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      // A runtime left in a bad state (out of memory) is dropped with its module's next use.
      modulePromise = null;
    }
  }
}
