import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/services/**/*.js", "src/importers/**/*.js", "src/reports/**/*.js"],
      exclude: ["src/seed/**"],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 85,
      },
    },
  },
});
