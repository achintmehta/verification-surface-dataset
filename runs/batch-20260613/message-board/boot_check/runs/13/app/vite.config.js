import { defineConfig } from 'vite';

// Vite dev server config. The API is served by the Node backend on
// port 3000; the dev server proxies API calls so the frontend can use
// same-origin paths during development as well.
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
  build: {
    outDir: 'dist',
  },
});
