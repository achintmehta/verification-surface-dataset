import { defineConfig } from 'vite';

// The frontend lives in /public (index.html + main.js).
// During development Vite proxies API + SSE requests to the Node server.
export default defineConfig({
  root: 'public',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE needs proxying without buffering
        ws: false,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
