// @ts-check
const { defineConfig, devices } = require("@playwright/test");

// The LivelyKernel dev server (bin/lk-server.js, via life_star) defaults to
// port 9001 (see bin/env.js's LIFE_STAR_PORT) and normally runs inside WSL,
// not from a Windows shell -- see CLAUDE.md/memory "Server runs in WSL".
// Deliberately NOT using Playwright's `webServer` option to auto-spawn it:
// that would launch a second, Windows-side server process fighting the real
// one for the same port instead of reusing it. Tests assume the server is
// already running at baseURL and fail fast (via the smoke test) if it isn't.
const PORT = process.env.LK_TEST_PORT || 9001;
const BASE_URL = process.env.LK_TEST_BASE_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
