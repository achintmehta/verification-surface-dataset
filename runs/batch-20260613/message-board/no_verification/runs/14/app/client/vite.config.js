import { defineConfig } from 'vite';

// Proxy API requests to the backend during development so the frontend
// can use same-origin relative URLs (/api/...).
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
