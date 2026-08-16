import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api/* requests to the Express backend during development.
      // This avoids CORS issues and lets the frontend use relative URLs.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE requires that the proxy does not buffer the response.
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url?.startsWith('/api/stream')) {
              // Ensure no response buffering for SSE.
            }
          });
        },
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
