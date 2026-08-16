import { defineConfig } from 'vite';

// Frontend dev server. API requests are proxied to the Node backend.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE needs the proxy to not buffer
        ws: false
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
