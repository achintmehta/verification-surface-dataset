import { defineConfig } from 'vite';

// The frontend dev server proxies API requests to the Node.js backend
// so that the browser can talk to both through a single origin during
// development. In production the same Express server serves the built
// static assets, so no proxy is required.
const API_TARGET = process.env.API_TARGET || 'http://localhost:3000';

export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
