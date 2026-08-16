import { defineConfig } from 'vite';

const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API + SSE to the backend during development.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
