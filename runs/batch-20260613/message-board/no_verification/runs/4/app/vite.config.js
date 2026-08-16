import { defineConfig } from 'vite';

/**
 * Vite configuration
 *
 * During development the Vite dev server runs on port 5173 while the
 * Express backend runs on port 3000.  The proxy below forwards every
 * /api/* request from the frontend to the backend so we avoid CORS
 * issues and can use a simple relative URL ("/api/...") in the client
 * code.
 *
 * The SSE endpoint requires special treatment:
 *   - changeOrigin: true  – rewrites the Host header
 *   - ws: false           – we are using SSE (HTTP), not WebSockets
 *
 * The `configure` hook disables response buffering on the proxy so that
 * SSE events are forwarded to the browser immediately rather than being
 * held in a buffer until the connection closes.
 */
export default defineConfig({
  // Tell Vite that the source root is the client/ directory.
  root: 'client',

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Disable buffering for SSE streams.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // If the upstream response is an event-stream, ensure the proxy
            // does not buffer it.
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
    // Output the production build to <project-root>/dist so it can be
    // served as static files by the Express server if desired.
    outDir: '../dist',
    emptyOutDir: true,
  },
});
