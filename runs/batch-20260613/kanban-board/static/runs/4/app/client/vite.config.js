import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api/* requests to the Express backend during development
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE requires streaming – disable response buffering
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Ensure SSE responses are not buffered
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
