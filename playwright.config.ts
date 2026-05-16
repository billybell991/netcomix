import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  webServer: {
    command: "npm run dev -- --port 5173",
    url: "http://localhost:5173/netcomix/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: "http://localhost:5173/netcomix/",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on",
  },
  projects: [
    {
      name: "headless",
      testMatch: "critical-path.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "visual",
      testMatch: "visual-qa.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        headless: false,
        launchOptions: { slowMo: 100 },
        video: "on",
      },
    },
    {
      name: "regression",
      testMatch: "visual-regression.spec.ts",
      retries: 1,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
