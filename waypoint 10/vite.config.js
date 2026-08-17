import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 3000,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
