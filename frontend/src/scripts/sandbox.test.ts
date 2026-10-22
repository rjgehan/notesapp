import { describe, expect, it } from 'vitest';
import { runInSandbox } from './sandbox';

const NOW = Date.UTC(2026, 9, 19, 9, 30); // Monday 2026-10-19 09:30, local wall time

async function run(code: string, host: (name: string, args: unknown) => unknown = () => null, cpu?: number) {
  return runInSandbox({ code, path: 'Here.md', now: NOW }, async (name, args) => {
    try {
      return JSON.stringify({ v: await host(name, JSON.parse(args)) });
    } catch (e) {
      return JSON.stringify({ e: (e as Error).message });
    }
  }, cpu);
}

describe('script sandbox (ROADMAP 40)', () => {
  it('runs a script and collects what it shows', async () => {
    const r = await run('show("**hi**"); show(1 + 1); show(today().weekday, today().format("DD MMMM YYYY"))');
    expect(r.error).toBeNull();
    expect(r.output).toEqual([
      { t: 'md', v: '**hi**' },
      { t: 'text', v: '2' },
      { t: 'md', v: 'Monday' },
      { t: 'md', v: '19 October 2026' },
    ]);
  });
});

describe('script sandbox: the API', () => {
  it('has dates that count days and format', async () => {
    const r = await run(`
      show(today().daysUntil("2026-12-25"), date("2026-01-31").add(1, "month").toString(), now().format("HH:mm"));
      show(today().add(-1, "day").weekday, date("2026-10-17").isBefore(today()));`);
    expect(r.error).toBeNull();
    expect(r.output.map((o) => ('v' in o ? o.v : null))).toEqual(['67', '2026-02-28', '09:30', 'Sunday', 'true']);
  });

  it('reads notes through the page and shows lists, tables, links and embeds', async () => {
    const meta = { path: 'P/A.md', title: 'A', aliases: [], tags: ['project'], frontmatter: { status: 'open', mood: 3 }, mtimeLocal: NOW, size: 1, links: [], tasks: null };
    const calls: [string, unknown][] = [];
    const r = await run(
      `const ns = notes({ tag: "project" }).filter(n => n.props.status !== "done");
       show(list(ns), table(ns, ["title", "mood", "status"]), embed("Monday notes"), thisNote().title, ns[0].text())`,
      (name, args) => {
        calls.push([name, args]);
        if (name === 'notes') return [meta];
        if (name === 'note') return { ...meta, path: 'Here.md', title: 'Here' };
        if (name === 'text') return '# A';
        return null;
      },
    );
    expect(r.error).toBeNull();
    expect(calls.map((c) => c[0])).toEqual(['notes', 'note', 'text']);
    expect(calls[0][1]).toEqual({ tag: 'project' });
    expect(r.output).toEqual([
      { t: 'list', items: [{ t: 'link', path: 'P/A.md', title: 'A' }] },
      { t: 'table', columns: ['title', 'mood', 'status'], rows: [[{ t: 'link', path: 'P/A.md', title: 'A' }, { t: 'text', v: '3' }, { t: 'text', v: 'open' }]] },
      { t: 'embed', target: 'Monday notes' },
      { t: 'md', v: 'Here' },
      { t: 'md', v: '# A' },
    ]);
  });

  it('reports errors with their line, and API errors as exceptions the script may catch', async () => {
    const r = await run('show(1)\nconst x = 2;\nundefinedFunction()');
    expect(r.output).toEqual([{ t: 'text', v: '1' }]);
    expect(r.error).toMatchObject({ kind: 'script', line: 3 });
    expect(r.error?.message).toContain('undefinedFunction');
    const caught = await run('try { note("x") } catch (e) { show("caught: " + e.message) }', () => {
      throw new Error('nope');
    });
    expect(caught.output).toEqual([{ t: 'md', v: 'caught: nope' }]);
  });
});

describe('script sandbox: escapes and limits', () => {
  it('gives the script no DOM, network, storage, workers, timers or messaging', async () => {
    const names = ['window', 'document', 'self', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'postMessage', 'indexedDB', 'localStorage', 'caches', 'navigator', 'location', 'Worker', 'setTimeout', 'require', 'process', 'std', 'os', '__host', '__emit', '__ctx'];
    const r = await run(`show(${JSON.stringify(names)}.filter(n => typeof globalThis[n] !== "undefined").join(",") || "none")`);
    expect(r.output).toEqual([{ t: 'md', v: 'none' }]);
    // The global object reached any other way is the sandbox's own.
    const g = await run('show(typeof Function("return this")().document, typeof (0, eval)("this").fetch)');
    expect(g.output).toEqual([{ t: 'md', v: 'undefined' }, { t: 'md', v: 'undefined' }]);
    // No modules can be imported.
    const imp = await run('import("https://example.com/x.js").then(() => show("loaded"), (e) => show("refused"))');
    expect(imp.output.some((o) => 'v' in o && o.v === 'loaded')).toBe(false);
  });

  it('cannot change the API, and the page only gets JSON data back', async () => {
    const r = await run('try { globalThis.show = 1 } catch (e) {} ; Object.prototype.polluted = 1; show(typeof show)');
    expect(r.output).toEqual([{ t: 'md', v: 'function' }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('stops a runaway loop at the CPU limit', async () => {
    const started = performance.now();
    const r = await run('show("before"); while (true) {}', undefined, 100);
    expect(r.error?.kind).toBe('timeout');
    expect(r.output).toEqual([{ t: 'md', v: 'before' }]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('does not count time spent waiting for the page against the CPU limit', async () => {
    const r = await run('for (let i = 0; i < 3; i++) note("x"); show("done")', () => new Promise((resolve) => setTimeout(() => resolve(null), 60)), 100);
    expect(r.error).toBeNull();
    expect(r.output).toEqual([{ t: 'md', v: 'done' }]);
  });

  it('stops a script that allocates too much memory', async () => {
    const r = await run('const s = "x".repeat(1 << 20); const a = []; while (true) a.push(s + a.length);', undefined, 10000);
    expect(r.error?.kind).toBe('memory');
  });

  it('stops deep recursion', async () => {
    const r = await run('function f(n) { return f(n + 1) + 1 } f(0)');
    expect(r.error?.kind).toBe('script');
    expect(r.error?.message).toMatch(/stack/i);
  });

  it('caps the output and the number of API calls', async () => {
    const big = await run('for (let i = 0; i < 5000; i++) show(i)');
    expect(big.error?.kind).toBe('output');
    expect(big.output.length).toBe(2000);
    const chatty = await run('for (let i = 0; i < 500; i++) note("x")');
    expect(chatty.error?.kind).toBe('host');
  });

  it('runs every script in a fresh runtime', async () => {
    await run('globalThis.leak = 42');
    const r = await run('show(typeof leak)');
    expect(r.output).toEqual([{ t: 'md', v: 'undefined' }]);
  });
});
