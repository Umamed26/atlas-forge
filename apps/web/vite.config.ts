import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Workspace packages are TypeScript sources; let Vite transpile them instead
  // of pre-bundling them into node_modules cache.
  optimizeDeps: { exclude: ["@atlas/core", "@atlas/render"] },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  worker: { format: "es" },
});
