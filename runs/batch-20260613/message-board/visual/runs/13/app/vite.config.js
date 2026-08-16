import { defineConfig } from 'vite';

// During development the frontend dev server proxies /api requests to the
// Node.js backend, so the browser only ever talks to one origin.
export default defineConfig({
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
  },
});
