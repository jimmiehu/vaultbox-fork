import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: new URL("./tests/mocks/obsidian.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["e2e/**/*.e2e.test.ts"],
  },
});
