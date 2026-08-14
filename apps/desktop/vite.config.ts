import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri drives these: it runs vite on a fixed port and needs a stable, non-random host.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    // Must precede the react plugin so generated routes are transformed.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust rebuilds are Cargo's job; watching target/ would thrash the dev server.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri ships a known WebView2/WebKit, so we can target it directly.
    target: "chrome110",
    sourcemap: true,
    rollupOptions: {
      // Two webviews, two entries: the app and the pinned overlay window.
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
      },
    },
  },
});
