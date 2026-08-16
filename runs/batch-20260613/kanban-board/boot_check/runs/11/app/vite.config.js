import { defineConfig } from 'vite';

// The frontend (in /client) talks to the backend on port 3001.
// During development we proxy API and SSE requests to the backend so the
// browser only ever sees a single origin.
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
