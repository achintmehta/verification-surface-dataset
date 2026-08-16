import { defineConfig } from "vite";

// Proxy /api requests to the Express backend during development so the
// frontend can use same-origin relative URLs.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
