import { defineConfig } from 'vite';

const backendPort = Number(process.env.PORT || 3000);

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
});
