import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',          // client/ is the root when Vite is invoked with `vite client`
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api/* requests to the Express backend during development.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE streams must not be buffered.
        configure: (proxy) => {
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
