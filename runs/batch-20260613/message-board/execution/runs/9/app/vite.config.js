import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
