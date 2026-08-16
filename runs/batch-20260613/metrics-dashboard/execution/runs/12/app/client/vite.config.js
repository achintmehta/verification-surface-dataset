import { defineConfig } from 'vite';

// During development the API runs on :3001. We proxy /api so the frontend
// can use same-origin relative URLs and we avoid CORS surprises.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
