import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the backend during development so we avoid CORS
      // issues and don't need to hard-code the backend URL in the frontend.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE connections must not be buffered.
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url?.startsWith('/api/stream')) {
              // Ensure the proxy does not buffer the SSE stream.
            }
          });
        },
      },
    },
  },
});
