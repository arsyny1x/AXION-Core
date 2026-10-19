import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/lua-api/tests/**/*.test.ts",
      "src/axion/tests/**/*.test.ts",
      "src/services/tests/**/*.test.ts",
      "src/i18n/tests/**/*.test.ts",
    ],
  },
});