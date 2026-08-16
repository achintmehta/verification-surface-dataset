import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  // Proxy API calls to the Express backend during development so the
  // frontend dev server and the API share the same origin from the
  // browser's perspective (avoids CORS preflight for SSE).
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
