import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 3000,
    // public/images/hotels is served directly by server.js (/images/...);
    // don't duplicate ~400 downloaded images into dist/.
    copyPublicDir: false,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
