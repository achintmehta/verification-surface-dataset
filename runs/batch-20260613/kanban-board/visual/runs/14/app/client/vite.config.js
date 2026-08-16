import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3001';

export default defineConfig({
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
