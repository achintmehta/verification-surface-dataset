import { defineConfig } from 'vite';

// The dev server proxies API calls to the backend so the client can use
// same-origin relative URLs and avoid CORS in dev.
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
});
