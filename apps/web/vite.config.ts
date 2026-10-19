import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs are required by the Electron shell: the packaged renderer
  // is served from the privileged app:// protocol, not an http:// origin (see
  // apps/desktop/src/main/index.ts).
  base: "./",
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
