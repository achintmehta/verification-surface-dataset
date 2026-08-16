import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'frontend',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/api/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true
      }
    }
  }
});