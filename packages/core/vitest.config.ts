import { defineConfig } from "vitest/config";

/**
 * The core test suite runs the real simulation (30-seed hydrology invariants,
 * 1024² performance) and shares this machine with the dev servers and the other
 * agents' Playwright runs. A generous timeout avoids flakes that are pure CPU
 * contention, while every test still asserts its own budget.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite runs the real simulation at 1024²; running test files in
    // parallel would make the performance test compete with our own heavy
    // tests (and with the dev servers / other agents on this box). Serial
    // execution keeps timings meaningful and the cache tests deterministic.
    fileParallelism: false,
  },
});
