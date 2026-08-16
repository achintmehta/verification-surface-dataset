import { defineConfig } from 'vite';

const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';

export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
