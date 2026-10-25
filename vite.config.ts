import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Extension pages (popup + dashboard). The service worker and injected scripts use vite.scanner.config.ts. */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: "index.html",
        dashboard: "dashboard.html",
        blocked: "blocked.html"
      }
    }
  }
});
