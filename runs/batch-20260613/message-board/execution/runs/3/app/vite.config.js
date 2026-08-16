import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api requests to the Express backend during development
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE streams must not be buffered
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url?.startsWith('/api/stream')) {
              // Disable response buffering for SSE
              req.socket.setTimeout(0);
            }
          });
        },
      },
    },
  },
});
