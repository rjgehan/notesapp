/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Dockerfile sets VITE_BUILD_SHA; everywhere else the build is "dev", which the
// backend also reports outside the image, so the version check never fires (DESIGN §6.18).
const buildSha = process.env.VITE_BUILD_SHA || 'dev'

// The dev backend's address, IPv4 on purpose: Node on Windows may resolve "localhost" to ::1 while the
// backend binds 127.0.0.1. Override it when :8080 is taken; the backend's notes.allowed-hosts must then
// list the Vite origin's host:port.
const backendUrl = process.env.NOTES_DEV_BACKEND || 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(buildSha),
  },
  server: {
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
