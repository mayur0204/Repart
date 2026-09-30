import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, e2eEnv } from "./tests/e2e/support/env";

/**
 * E2E + screenshots at 375px and 1440px (REPART_BRIEF.md "How to work", PLAN.md §8.3, §10).
 * A production build started locally, the worker (global setup), the local test Postgres seeded with SAMPLE data,
 * Redis DB 1 and mock providers. Journeys share one seeded database, so files run one at a time.
 * Set E2E_REUSE_SERVER=1 to reuse an already running e2e server on port 3100.
 */
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "mobile-375", use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 375, height: 812 } } },
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    env: e2eEnv(),
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 400_000,
  },
});
