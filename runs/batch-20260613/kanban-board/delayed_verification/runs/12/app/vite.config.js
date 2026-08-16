import { defineConfig } from 'vite';

// The frontend dev server proxies API and SSE requests to the backend
// running on port 3001 so the SPA can talk to it without CORS issues
// during development.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs streaming; disabling buffering keeps events flowing.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Connection', 'keep-alive');
          });
        }
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
