import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: mode === "test" ? [] : [{
      find: /^module$/,
      replacement: fileURLToPath(new URL("./src/vite/wasmoon-browser-module.ts", import.meta.url)),
    }],
  },
  define: {
    __COMPUTER_NAME__: JSON.stringify(hostname().toUpperCase()),
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
}));
