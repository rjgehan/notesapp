/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// The Dockerfile sets VITE_BUILD_SHA; everywhere else the build is "dev", which the
// backend also reports outside the image, so the version check never fires (DESIGN §6.18).
const buildSha = process.env.VITE_BUILD_SHA || 'dev'

// The dev backend's address, IPv4 on purpose: Node on Windows may resolve "localhost" to ::1 while the
// backend binds 127.0.0.1. Override it when :8080 is taken; the backend's notes.allowed-hosts must then
// list the Vite origin's host:port.
const backendUrl = process.env.NOTES_DEV_BACKEND || 'http://127.0.0.1:8080'

// Excalidraw's fonts are self-hosted (DESIGN §6.8.1): the CSP blocks its CDN fallback. They go into a
// folder named after the package version under /assets/, which the server caches as immutable.
const excalidrawPackage = resolve('node_modules/@excalidraw/excalidraw')
const excalidrawVersion = (JSON.parse(readFileSync(join(excalidrawPackage, 'package.json'), 'utf8')) as { version: string }).version
const excalidrawAssets = `assets/excalidraw-${excalidrawVersion}/`
const excalidrawFonts = join(excalidrawPackage, 'dist', 'prod', 'fonts')

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]))
}

function excalidrawFontsPlugin(): Plugin {
  const prefix = `/${excalidrawAssets}fonts/`
  return {
    name: 'notesapp-excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (!url.startsWith(prefix)) return next()
        const file = resolve(excalidrawFonts, decodeURIComponent(url.slice(prefix.length)))
        if (!file.startsWith(excalidrawFonts + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next()
        res.setHeader('Content-Type', 'font/woff2')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const file of filesUnder(excalidrawFonts)) {
        this.emitFile({
          type: 'asset',
          fileName: `${excalidrawAssets}fonts/${relative(excalidrawFonts, file).split(sep).join('/')}`,
          source: readFileSync(file),
        })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), excalidrawFontsPlugin()],
  define: {
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(buildSha),
    'import.meta.env.VITE_EXCALIDRAW_ASSETS': JSON.stringify('/' + excalidrawAssets),
  },
  resolve: {
    alias: [
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
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
