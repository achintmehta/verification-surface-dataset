import { defineConfig } from 'vite';

// The frontend lives in /public-src and is served at the project root during dev.
// API calls are proxied to the backend running on port 3001.
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
