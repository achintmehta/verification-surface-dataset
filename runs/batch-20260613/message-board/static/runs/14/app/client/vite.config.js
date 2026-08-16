import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3001';

export default defineConfig({
  server: {
    port: 5173,
    // Proxy API calls to the Express backend during development so the
    // frontend can use same-origin relative URLs (great for SSE too).
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
