import { defineConfig } from 'vite';

// Proxy /api to the backend so the frontend can call relative URLs in dev.
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
