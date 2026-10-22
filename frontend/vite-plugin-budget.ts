// The main chunk's budget (DESIGN §6.1.1): the JavaScript a page loads before it can render
// anything, which is the entry chunk and every chunk it imports statically, gzipped. The build fails
// when it exceeds the budget, so a static import that pulls CodeMirror, a parser or a view's code
// back into the main chunk is caught where it is made, not on a phone.
import { gzipSync } from 'node:zlib';
import type { Logger, Plugin } from 'vite';

export interface InitialJs {
  files: string[];
  raw: number;
  gzip: number;
}

interface ChunkLike {
  type: 'chunk' | 'asset';
  isEntry?: boolean;
  imports?: string[];
  code?: string;
  facadeModuleId?: string | null;
}

/** The entry chunk(s) whose facade module ends with `entry` (the page's index.html) and their static imports, with their sizes. */
export function initialJs(bundle: Record<string, ChunkLike>, entry: string): InitialJs {
  const start = Object.entries(bundle)
    .filter(([, c]) => c.type === 'chunk' && c.isEntry && (c.facadeModuleId ?? '').replace(/\\/g, '/').endsWith(entry))
    .map(([name]) => name);
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(bundle[name]?.imports ?? []));
  }
  let raw = 0;
  let gzip = 0;
  for (const name of seen) {
    const code = Buffer.from(bundle[name]?.code ?? '');
    raw += code.length;
    gzip += gzipSync(code, { level: 9 }).length;
  }
  return { files: [...seen].sort(), raw, gzip };
}

export function bundleBudget(options: { entry: string; maxGzipKiB: number }): Plugin {
  let logger: Logger | null = null;
  return {
    name: 'notesapp:bundle-budget',
    apply: 'build',
    configResolved(config) {
      logger = config.logger;
    },
    generateBundle(_, bundle) {
      const initial = initialJs(bundle as unknown as Record<string, ChunkLike>, options.entry);
      if (initial.files.length === 0) this.error(`no entry chunk for ${options.entry}`);
      const kib = (n: number) => `${(n / 1024).toFixed(0)} KiB`;
      const summary = `initial JS: ${initial.files.length} files, ${kib(initial.raw)} raw, ${kib(initial.gzip)} gzip (budget ${options.maxGzipKiB} KiB)`;
      if (initial.gzip > options.maxGzipKiB * 1024) this.error(`${summary}. A static import pulled lazy code into the main chunk (DESIGN §6.1.1).`);
      logger?.info(summary);
    },
  };
}
