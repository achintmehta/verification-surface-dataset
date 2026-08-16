import { defineConfig } from 'vite';

export default defineConfig({
  // The source root for the frontend is the `client/` directory
  root: 'client',
  server: {
    port: 5173,
    // Proxy API calls to the Express backend so we don't need absolute URLs
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Output the production build to `dist/` at the project root
    outDir: '../dist',
    emptyOutDir: true,
  },
});
