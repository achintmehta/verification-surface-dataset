import { defineConfig } from 'vite';

// The frontend talks to the backend on port 3001. In dev we proxy /api to it
// so the browser makes same-origin requests (no CORS surprises during dev).
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
