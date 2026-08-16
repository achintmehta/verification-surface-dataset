import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT || 3000);

export default defineConfig({
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
});
