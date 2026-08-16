import { defineConfig } from 'vite';

// The frontend dev server proxies API + SSE requests to the Node backend so
// that EventSource and fetch can use same-origin relative URLs.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
