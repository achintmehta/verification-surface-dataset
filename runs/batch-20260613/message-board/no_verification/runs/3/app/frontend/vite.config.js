import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api requests to the Express backend during development so
      // the frontend never has to hard-code the backend URL.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE streams must not be buffered – disable the proxy's own timeout.
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url?.startsWith('/api/stream')) {
              // Ensure the proxy does not buffer the SSE response.
              req.socket.setTimeout(0);
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
