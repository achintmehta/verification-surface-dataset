import { defineConfig } from 'vite';

// Frontend dev server proxies API + SSE calls to the Node backend.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs no buffering / keep the connection open
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
