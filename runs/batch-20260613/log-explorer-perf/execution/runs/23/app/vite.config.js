import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  server: {
    port: 3001,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
