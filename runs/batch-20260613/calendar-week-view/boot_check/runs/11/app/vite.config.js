import { defineConfig } from 'vite';

// The frontend lives in ./client. During development Vite proxies API
// requests to the Express backend so both run from the same origin.
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
