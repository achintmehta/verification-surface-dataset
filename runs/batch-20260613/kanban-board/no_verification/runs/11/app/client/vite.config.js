import { defineConfig } from 'vite';

const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API + SSE requests to the backend during development.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Ensure SSE streams are not buffered.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform';
          });
        },
      },
    },
  },
});
