import { defineConfig } from 'vite';

// The frontend dev server proxies API + SSE requests to the backend
// running on port 3001 so the client can use same-origin relative URLs.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs the proxy to not buffer the response.
        ws: false,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
