import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `core` and `plugin-sdk` are deliberately DOM-free, so node is the honest
    // environment. Anything needing a real canvas belongs in a browser-mode project.
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
