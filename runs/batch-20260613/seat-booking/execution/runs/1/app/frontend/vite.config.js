import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the backend during development so we avoid CORS
      // issues when running both servers locally.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE requires streaming – disable response buffering.
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url.startsWith('/api/stream')) {
              // nothing special needed; just let it stream
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
