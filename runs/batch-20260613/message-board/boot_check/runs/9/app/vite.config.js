import { defineConfig } from 'vite';

const backendPort = process.env.BACKEND_PORT || process.env.PORT || 3000;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${backendPort}`
    }
  }
});
