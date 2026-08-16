import { defineConfig } from 'vite';

// Frontend dev server. API and SSE requests are proxied to the backend
// so the SPA can use same-origin relative URLs in development.
export default defineConfig({
  root: 'frontend',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE requires no buffering / keep-alive support; Vite's proxy
        // streams responses through, which works for EventSource.
        ws: false
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
