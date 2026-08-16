import { defineConfig } from 'vite';

export default defineConfig({
  // The root of the client project is the "client" directory itself.
  root: '.',
  server: {
    port: 5173,
    // Proxy API calls to the Express backend so the frontend never has to
    // hard-code the backend URL or deal with CORS during development.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
