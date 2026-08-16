import { defineConfig } from 'vite';

// During development the Vite dev server proxies API calls to the Express
// backend so the SPA can use same-origin relative URLs (/api/...).
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
