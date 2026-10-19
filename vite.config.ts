import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hostname } from "node:os";

export default defineConfig({
  plugins: [react()],
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
});
