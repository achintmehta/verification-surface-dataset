import { defineConfig } from "vite";

const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:3001";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API + SSE requests to the backend during development so the
      // frontend can use same-origin relative URLs.
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
