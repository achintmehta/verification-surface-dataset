import { defineConfig } from 'vite';

// The frontend SPA lives in /public-src and talks to the backend API.
// During development the backend runs on :3001 and Vite proxies /api to it.
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
