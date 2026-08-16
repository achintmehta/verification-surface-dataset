import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api requests to the backend during development.
      // SSE requires special handling: no buffering, no timeout.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Disable proxy timeout for long-lived SSE connections
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
