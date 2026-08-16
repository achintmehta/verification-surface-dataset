import { defineConfig } from 'vite';

// The frontend is a static SPA served from the project root (index.html).
// During development it proxies API calls to the Express backend so the
// client can use same-origin relative URLs (/api/...).
export default defineConfig({
  root: '.',
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
    outDir: 'dist',
    emptyOutDir: true,
  },
});
