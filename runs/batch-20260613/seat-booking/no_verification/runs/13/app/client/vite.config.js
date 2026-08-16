import { defineConfig } from 'vite';

// The frontend dev server proxies API + SSE calls to the Node backend so the
// browser can use same-origin relative URLs.
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
