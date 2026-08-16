import { defineConfig } from 'vite';

// The frontend is a Vanilla JS SPA served from the `frontend` directory.
// During development, API and SSE requests are proxied to the backend server.
export default defineConfig({
  root: 'frontend',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
