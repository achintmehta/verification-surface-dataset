import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE needs streaming – disable buffering
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url?.startsWith('/api/stream')) {
              // nothing extra needed; Vite's proxy handles streaming fine
            }
          });
        },
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
