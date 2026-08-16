import { defineConfig } from 'vite';

// During development, proxy API + SSE requests to the Node backend so the
// frontend can use same-origin relative URLs.
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
