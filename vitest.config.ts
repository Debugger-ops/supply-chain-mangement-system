import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    // Tests share one Redis instance and use distinct SKU keys per test to
    // stay isolated, so file-level parallelism is safe; keep it off only if
    // you point TEST_REDIS_DRIVER at a single-connection constrained setup.
    fileParallelism: true,
  },
});
