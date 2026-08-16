import { defineConfig } from 'vite';

// During development the frontend runs on Vite's dev server (default :5173)
// and proxies /api requests to the Express backend on :3000.
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
