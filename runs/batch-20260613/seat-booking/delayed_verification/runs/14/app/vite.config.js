import { defineConfig } from 'vite';

// The frontend runs on Vite's dev server (default port 5173).
// API and SSE requests are proxied to the Node backend on port 3001.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs no special config; keep default proxy behaviour.
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
