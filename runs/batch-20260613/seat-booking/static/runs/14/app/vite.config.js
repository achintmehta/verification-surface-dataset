import { defineConfig } from 'vite';

// The frontend dev server proxies API and SSE requests to the backend
// so the SPA can use same-origin relative URLs.
export default defineConfig({
  root: 'frontend',
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
