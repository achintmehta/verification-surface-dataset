import { defineConfig } from 'vite';

export default defineConfig({
  // The project root is the client/ directory itself.
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    // Proxy API calls to the Express backend during development so the
    // browser never has to deal with CORS for same-origin requests.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE streams must not be buffered.
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
