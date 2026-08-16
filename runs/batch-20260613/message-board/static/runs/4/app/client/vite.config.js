import { defineConfig } from "vite";

export default defineConfig({
  // Proxy API calls from the Vite dev server to the Express backend so we
  // never have to hard-code the backend URL in frontend code.
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // SSE streams must not be buffered.
        configure(proxy) {
          proxy.on("proxyReq", (_proxyReq, req) => {
            if (req.url?.startsWith("/api/stream")) {
              // Ensure the proxy doesn't buffer the SSE response.
              req.socket.setTimeout(0);
            }
          });
        },
      },
    },
  },
});
