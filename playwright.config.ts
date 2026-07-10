import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.e2e file for test environment variables
dotenv.config({ path: path.join(__dirname, ".env.e2e") });

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const parsedBaseURL = new URL(baseURL);
const isLocalBaseURL = ["localhost", "127.0.0.1", "[::1]"].includes(
  parsedBaseURL.hostname,
);
const localDevServerPort =
  parsedBaseURL.port || (parsedBaseURL.protocol === "https:" ? "443" : "80");

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true, // Run spec files in parallel (each tier uses different user)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 3, // Allow 3 concurrent workers (one per tier spec)
  reporter: "html",
  timeout: 60000,

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    navigationTimeout: 30000,
  },

  projects: [
    // Setup project - authenticates all tiers and saves storage state
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },
    // Main test project - depends on setup
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /.*\.setup\.ts/,
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: isLocalBaseURL
    ? {
        command: `corepack pnpm exec next dev --webpack --port ${localDevServerPort}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      }
    : undefined,
});
