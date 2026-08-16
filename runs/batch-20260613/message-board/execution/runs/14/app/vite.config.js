import { defineConfig } from 'vite';

// During development the Vite dev server proxies API requests to the Node
// backend so the frontend can use same-origin relative URLs everywhere.
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
