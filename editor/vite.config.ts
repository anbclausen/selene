import { defineConfig } from "vite";

// Tauri drives this dev server; keep the port fixed so tauri.conf.json's devUrl
// matches. clearScreen off so Vite doesn't wipe Rust/cargo logs in the shared
// terminal. Build output goes to dist/, which tauri.conf.json serves.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
