import { defineConfig } from 'vite';

// During development, proxy API + SSE requests to the backend so the
// browser talks to a single origin (avoids CORS and EventSource quirks).
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
