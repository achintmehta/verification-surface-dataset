import { defineConfig } from 'vite';

// During development the frontend proxies API and SSE calls to the backend so
// the browser uses a single origin (avoids CORS issues with EventSource).
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
