import { defineConfig } from 'vite';

// Frontend dev server proxies API + SSE requests to the Node backend.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs no buffering / long-lived connection
        ws: false
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
