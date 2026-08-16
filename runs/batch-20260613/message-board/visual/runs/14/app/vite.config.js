import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Proxy API calls to the backend during development so EventSource and
    // fetch can use same-origin relative paths if desired.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
});
