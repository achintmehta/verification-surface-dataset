import { defineConfig } from 'vite';

export default defineConfig({
  // Proxy API calls to the Express backend during development so the frontend
  // can use relative paths (/api/...) without CORS issues.
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE streams must not be buffered – disable the proxy's response
        // buffering so events are forwarded to the browser immediately.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Ensure the proxy does not buffer SSE responses.
            if (
              proxyRes.headers['content-type']?.includes('text/event-stream')
            ) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
