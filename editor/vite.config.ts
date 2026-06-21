import { defineConfig } from "vite";

// Tauri drives this dev server; keep the port fixed so tauri.conf.json's devUrl
// matches. clearScreen off so Vite doesn't wipe Rust/cargo logs in the shared
// terminal. Build output goes to dist/, which tauri.conf.json serves.
export default defineConfig({
  clearScreen: false,
  publicDir: "../assets",
  plugins: [
    {
      // The editor is a stateful single-page app: one CodeMirror view, live OSC
      // listeners, per-channel viz state. Hot-patching it leaves a stale module
      // (old editor + duplicate listeners) running alongside the new one, which
      // looks like "fixes don't apply / ghost visuals". Never hot-patch — do a
      // full page reload on every change so each load starts from a clean slate.
      name: "selene-full-reload",
      handleHotUpdate({ server }) {
        server.ws.send({ type: "full-reload" });
        return [];
      },
    },
  ],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
