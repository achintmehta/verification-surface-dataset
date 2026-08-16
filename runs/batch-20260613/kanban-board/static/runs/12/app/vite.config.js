import { defineConfig } from 'vite';

// The frontend dev server proxies API and SSE requests to the backend
// running on port 3001 so the browser can use same-origin fetch/EventSource.
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
