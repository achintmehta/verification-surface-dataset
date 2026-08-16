import { defineConfig } from 'vite';

// The frontend (SPA) is served from the project root (index.html + src/).
// API and SSE requests are proxied to the Express backend during development.
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
  },
});
