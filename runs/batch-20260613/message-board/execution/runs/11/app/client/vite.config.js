import { defineConfig } from 'vite';

// During development, proxy API + SSE requests to the Express backend so the
// frontend can use same-origin relative URLs (no CORS surprises, SSE works).
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
