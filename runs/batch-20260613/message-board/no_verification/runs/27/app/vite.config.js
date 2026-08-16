import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});