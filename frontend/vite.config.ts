/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { serviceWorker } from './vite-plugin-sw.ts'

// The Dockerfile sets VITE_BUILD_SHA; everywhere else the build is "dev", which the
// backend also reports outside the image, so the version check never fires (DESIGN §6.18).
const buildSha = process.env.VITE_BUILD_SHA || 'dev'

// The dev backend's address, IPv4 on purpose: Node on Windows may resolve "localhost" to ::1 while the
// backend binds 127.0.0.1. Override it when :8080 is taken; the backend's notes.allowed-hosts must then
// list the Vite origin's host:port.
const backendUrl = process.env.NOTES_DEV_BACKEND || 'http://127.0.0.1:8080'

// Package assets are self-hosted (DESIGN §6.8.1, §6.8.3): the CSP blocks CDNs. Each package's go into a
// folder named after its version under /assets/, which the server caches as immutable.
function packageDir(name: string): { dir: string; version: string } {
  const dir = resolve('node_modules', name)
  return { dir, version: (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version }
}

const excalidraw = packageDir('@excalidraw/excalidraw')
const excalidrawAssets = `assets/excalidraw-${excalidraw.version}/`
const pdfjs = packageDir('pdfjs-dist')
const pdfjsAssets = `assets/pdfjs-${pdfjs.version}/`

interface AssetMount {
  /** Folder under the build root, ending in `/`. */
  target: string
  /** Absolute source folder. */
  source: string
  /** Which of its files to serve and copy (the name relative to `source`, with `/`); all by default. */
  include?: (name: string) => boolean
}

const assetMounts: AssetMount[] = [
  // Excalidraw's fonts (DESIGN §6.8.1).
  { target: `${excalidrawAssets}fonts/`, source: join(excalidraw.dir, 'dist', 'prod', 'fonts') },
  // PDF.js (DESIGN §6.8.3): CMaps for CJK text, the standard fonts for PDFs that do not embed theirs, the
  // WebAssembly image decoders with their JavaScript fallbacks, the CMYK profile and the annotation icons.
  // quickjs-eval runs a PDF's own JavaScript, which the viewer never does.
  { target: `${pdfjsAssets}cmaps/`, source: join(pdfjs.dir, 'cmaps') },
  { target: `${pdfjsAssets}standard_fonts/`, source: join(pdfjs.dir, 'standard_fonts') },
  { target: `${pdfjsAssets}wasm/`, source: join(pdfjs.dir, 'wasm'), include: (name) => !name.startsWith('quickjs') },
  { target: `${pdfjsAssets}iccs/`, source: join(pdfjs.dir, 'iccs') },
  { target: `${pdfjsAssets}images/`, source: join(pdfjs.dir, 'web', 'images'), include: (name) => name.startsWith('annotation-') },
]

const devContentTypes: Record<string, string> = {
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  js: 'text/javascript',
  svg: 'image/svg+xml',
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]))
}

function mountedName(mount: AssetMount, file: string): string | null {
  const name = relative(mount.source, file).split(sep).join('/')
  return !mount.include || mount.include(name) ? name : null
}

function packageAssetsPlugin(): Plugin {
  return {
    name: 'notesapp-package-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        const mount = assetMounts.find((m) => url.startsWith(`/${m.target}`))
        if (!mount) return next()
        const file = resolve(mount.source, decodeURIComponent(url.slice(mount.target.length + 1)))
        if (!file.startsWith(mount.source + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile() || !mountedName(mount, file)) return next()
        res.setHeader('Content-Type', devContentTypes[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const mount of assetMounts) {
        for (const file of filesUnder(mount.source)) {
          const name = mountedName(mount, file)
          if (name) this.emitFile({ type: 'asset', fileName: mount.target + name, source: readFileSync(file) })
        }
      }
    },
  }
}

// The web clipper's scripts (DESIGN §6.27.1): the server serves clipper/dist/web at /clipper/ (the
// Dockerfile copies it in); the dev server does the same once `npm run build` ran in clipper/.
function clipperDevPlugin(): Plugin {
  const dir = resolve('..', 'clipper', 'dist', 'web')
  return {
    name: 'notesapp-clipper-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (!url.startsWith('/clipper/')) return next()
        const file = resolve(dir, decodeURIComponent(url.slice('/clipper/'.length)))
        if (!file.startsWith(dir + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  // The service worker is built after the app, from the files the build wrote (DESIGN §6.26).
  plugins: [react(), packageAssetsPlugin(), clipperDevPlugin(), serviceWorker({ entry: 'src/sw/sw.ts', buildSha })],
  define: {
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(buildSha),
    'import.meta.env.VITE_EXCALIDRAW_ASSETS': JSON.stringify('/' + excalidrawAssets),
    'import.meta.env.VITE_PDFJS_ASSETS': JSON.stringify('/' + pdfjsAssets),
  },
  resolve: {
    alias: [
      // Glide Data Grid's cell editor, a lazy chunk of the grid: the spreadsheet view loads it when
      // the grid mounts, so the first keystrokes of the first edit are not lost while it downloads
      // (DESIGN §6.21.5). The package exports no such path; this is the file its own import loads.
      {
        find: /^glide-overlay-editor$/,
        replacement: fileURLToPath(
          new URL('./node_modules/@glideapps/glide-data-grid/dist/esm/internal/data-grid-overlay-editor/data-grid-overlay-editor.js', import.meta.url),
        ),
      },
      // One Mermaid for the app and Excalidraw's Mermaid import, each with its own configuration
      // (src/render/rich/mermaidShared.ts, which imports the package by its file).
      { find: /^mermaid$/, replacement: fileURLToPath(new URL('./src/render/rich/mermaidShared.ts', import.meta.url)) },
      // Mermaid's optional ELK layout: elkjs is EPL-2.0 (not GPL-compatible) and 1.4 MB, so it is
      // left out of the bundle; diagrams use the dagre layout (src/render/rich/mermaid.ts).
      { find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: fileURLToPath(new URL('./src/render/rich/elkStub.ts', import.meta.url)) },
    ],
  },
  server: {
    // Tests also read docs/API.md (src/api/types.test.ts); the dev server keeps Vite's default allow list.
    fs: process.env.VITEST ? { allow: ['.', '../docs'] } : undefined,
    proxy: {
      // changeOrigin stays false so the backend's Host and Origin checks see the browser's host.
      '/api': {
        target: backendUrl,
        changeOrigin: false,
        // SSE responses are long-lived; never time them out in the proxy.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    sourcemap: true,
    rolldownOptions: {
      output: {
        // React and the router change rarely: in their own chunk they stay cached across deploys.
        codeSplitting: {
          groups: [{ name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ }],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Glide's cell editor is not loaded ahead in tests (src/test/glideOverlayEditor.ts).
    alias: { 'glide-overlay-editor': fileURLToPath(new URL('./src/test/glideOverlayEditor.ts', import.meta.url)) },
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
