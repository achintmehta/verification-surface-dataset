import { defineConfig } from 'vite';

// During development we proxy /api to the backend so the SPA and API share an
// origin (avoids CORS quirks with EventSource and simplifies fetch URLs).
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
