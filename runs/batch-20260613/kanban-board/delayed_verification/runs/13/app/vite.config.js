import { defineConfig } from 'vite';

// The frontend is a Vanilla JS SPA. During development the Vite dev server
// proxies API and SSE requests to the Express backend on port 3001.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE requires the proxy to not buffer the response.
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
