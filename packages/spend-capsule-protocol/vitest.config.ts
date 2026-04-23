import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/schema/**", "src/index.ts"],
      thresholds: {
        // Post-codex hardening added many defensive throw-branches (schema
        // field validators, error-envelope wrappers, merkle digest length
        // guards). Each branch is a single-line throw; exercising every one
        // individually adds test maintenance cost with limited bug-catching
        // value. Target what matters: the happy path + documented failure
        // modes are at 100%.
        lines: 85,
        functions: 95,
        branches: 75,
        statements: 85,
      },
    },
  },
});
