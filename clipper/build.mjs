// Builds the clipper (DESIGN §6.27.1) into dist/:
//   dist/chrome/, dist/firefox/  the extension, ready for "Load unpacked" / "Load Temporary Add-on"
//   dist/web/                    what the server serves under /clipper/ (the Dockerfile copies it):
//                                clipper.js (for the /clip page), shortcut.js (iOS Shortcut),
//                                bookmarklet.js (a javascript: URL with the origin left as a placeholder)
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = import.meta.dirname;
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome121', 'firefox128', 'safari16'],
  legalComments: 'eof',
  charset: 'utf8',
  logLevel: 'warning',
};

async function bundle(entry, outfile, extra = {}) {
  await build({ ...common, entryPoints: [join(root, entry)], outfile, ...extra });
}

rmSync(dist, { recursive: true, force: true });

// The web scripts.
const web = join(dist, 'web');
await bundle('src/web/clipper.ts', join(web, 'clipper.js'));
await bundle('src/web/shortcut.ts', join(web, 'shortcut.js'));
const bm = await build({ ...common, legalComments: 'none', entryPoints: [join(root, 'src/web/bookmarklet-entry.ts')], write: false });
const code = bm.outputFiles[0].text.trim();
// javascript: URLs are percent-decoded before they run, and '#' would start a fragment.
writeFileSync(join(web, 'bookmarklet.js'), 'javascript:' + encodeURIComponent(code));

// The extension, once per browser.
// manifest.ts, compiled for this script.
const manifestModule = join(dist, 'manifest.mjs');
await build({ ...common, format: 'esm', platform: 'node', minify: false, entryPoints: [join(root, 'src/extension/manifest.ts')], outfile: manifestModule });
const { manifest } = await import(pathToFileURL(manifestModule).href);
for (const target of ['chrome', 'firefox']) {
  const dir = join(dist, target);
  mkdirSync(dir, { recursive: true });
  await bundle('src/extension/background-entry.ts', join(dir, 'background.js'));
  await bundle('src/extension/content.ts', join(dir, 'content.js'));
  await bundle('src/extension/popup.ts', join(dir, 'popup.js'));
  await bundle('src/extension/options.ts', join(dir, 'options.js'));
  for (const f of ['popup.html', 'options.html', 'ui.css']) cpSync(join(root, 'src/extension', f), join(dir, f));
  cpSync(join(root, 'icons'), join(dir, 'icons'), { recursive: true });
  cpSync(join(root, 'LICENSES.md'), join(dir, 'LICENSES.md'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(target, version), null, 2) + '\n');
}
rmSync(manifestModule, { force: true });
console.log(`clipper ${version} built into dist/`);
