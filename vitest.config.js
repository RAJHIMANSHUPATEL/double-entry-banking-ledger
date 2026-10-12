import { defineConfig } from "vitest/config";

// A filtered phase run does not execute every service branch. The 85% line gate
// is enforced when `npm test` runs the whole suite, which is the commit check.
const filtered = process.argv.some((arg) => arg.includes("tests/") || arg.endsWith(".test.js"));

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
      thresholds: filtered ? undefined : { lines: 85 },
    },
  },
});
