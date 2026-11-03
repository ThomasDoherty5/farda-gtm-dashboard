import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys, accessibility and visual comparison (THO-330).
 * Viewports follow handoff section 11: 390, 768, 1024, 1440, 1920.
 * Visual baselines are Figma captures stored under e2e/figma-captures/,
 * never auto-updated from the implementation (handoff section 12, gate 5).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:4173",
    timezoneId: "America/Los_Angeles",
    locale: "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } },
    { name: "mobile-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
  ],
  webServer: { command: "npm run build && npm run preview", url: "http://localhost:4173", reuseExistingServer: !process.env.CI, timeout: 180_000 },
});
