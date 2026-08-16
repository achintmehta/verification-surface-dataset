import { defineConfig } from 'vite';

// During development the frontend runs on Vite's dev server (5173) and the
// API on Express (3001). Proxy /api to the backend so the client can use
// same-origin relative URLs in both dev and production.
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
