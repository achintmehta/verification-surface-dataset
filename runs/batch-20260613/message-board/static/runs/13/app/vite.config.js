import { defineConfig } from 'vite';

// The frontend dev server proxies API requests to the Node.js backend so that
// the browser only ever talks to a single origin during development. This keeps
// EventSource (SSE) and fetch calls working without CORS friction.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
