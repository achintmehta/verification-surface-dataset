import { defineConfig } from 'vite';

// The dev server proxies /api to the backend so the frontend can use
// same-origin relative URLs (no CORS surprises during development).
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
