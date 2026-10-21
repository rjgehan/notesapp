// Builds the service worker after the app (DESIGN §6.26). Once the app bundle and the public files
// are written, it lists the output, compiles the precache list and a version (a hash of the build
// SHA and every precached file) into src/sw/sw.ts, and bundles that as one classic script at
// dist/sw.js. A deploy that changes any precached byte therefore ships a new sw.js, which is how
// browsers find out about it (the server sends sw.js with `no-cache`).
//
// Hand-written instead of vite-plugin-pwa/Workbox: the worker is small and its update flow is tied
// to the app's own build check and unsaved-edit state (state/buildCheck.ts), which neither of the
// plugin's registration modes fits, and Workbox's build tooling would add a second bundler.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';
import { precacheUrls } from './src/sw/core.ts';

async function listFiles(dir: string, base: string = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

export interface ServiceWorkerOptions {
  /** The worker's entry module, relative to the Vite root. */
  entry: string;
  /** The build SHA the app is built with (VITE_BUILD_SHA). */
  buildSha: string;
}

export function serviceWorker(options: ServiceWorkerOptions): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'notesapp:service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const urls = precacheUrls(await listFiles(outDir));
      const hash = createHash('sha256').update(options.buildSha);
      for (const url of urls) {
        hash.update('\0' + url + '\0');
        hash.update(await readFile(join(outDir, url.slice(1))));
      }
      const version = hash.digest('hex').slice(0, 16);
      await build({
        configFile: false,
        root: config.root,
        logLevel: 'warn',
        publicDir: false,
        define: {
          __SW_BUILD__: JSON.stringify(options.buildSha),
          __SW_VERSION__: JSON.stringify(version),
          __SW_PRECACHE__: JSON.stringify(urls),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          reportCompressedSize: false,
          lib: {
            entry: resolve(config.root, options.entry),
            formats: ['iife'],
            name: 'notesappServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
      config.logger.info(`service worker: sw.js precaches ${urls.length} files (version ${version})`);
    },
  };
}
