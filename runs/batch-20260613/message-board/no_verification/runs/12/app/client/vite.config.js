import { defineConfig } from "vite";

// During development the Vite dev server proxies `/api` requests to the
// Node.js backend so the frontend can use same-origin relative URLs.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
