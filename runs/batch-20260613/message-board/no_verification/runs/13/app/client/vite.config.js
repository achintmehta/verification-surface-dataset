import { defineConfig } from "vite";

// During development the Vite dev server proxies API/SSE requests to the
// Express backend so the frontend can use same-origin relative URLs.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
