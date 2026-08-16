import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE requires that the proxy does not buffer the response.
        // Vite's http-proxy passes through streaming responses by default.
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
