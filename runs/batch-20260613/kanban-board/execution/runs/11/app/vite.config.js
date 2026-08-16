import { defineConfig } from 'vite';

// The frontend is a Vanilla JS SPA served from the project root (index.html).
// During development the Vite dev server proxies API + SSE requests to the
// Express backend running on port 3001.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs the connection kept alive; disable buffering by not
        // rewriting and letting the proxy stream.
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
