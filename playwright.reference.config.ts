import { defineConfig, devices } from "@playwright/test";

/**
 * One browser journey against the REFERENCE SERVER (a test double, not the backend): the built app with
 * VITE_FARDA_ADAPTER=sandbox reading over real HTTP. Run with `npm run test:e2e:reference`.
 * `npm run test:e2e` and `npm run verify` never start the server and do not read this file.
 *
 * The spec starts and stops the server itself (it has to stop it mid-test), so only the app build is a webServer here.
 * The server's address is baked into the build, so both ports are fixed; override with E2E_REF_APP_PORT / E2E_REF_SERVER_PORT.
 * The app and the server both use `localhost`, because the session cookie is SameSite=Lax and host-based.
 */
const appPort = Number(process.env.E2E_REF_APP_PORT ?? 4181);
const serverPort = Number(process.env.E2E_REF_SERVER_PORT ?? 8788);

export default defineConfig({
  testDir: "./e2e-reference",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${appPort}`, timezoneId: "America/Los_Angeles", locale: "en-US", colorScheme: "light", reducedMotion: "reduce", trace: "retain-on-failure" },
  projects: [{ name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }],
  webServer: {
    // Its own output folder, so it never overwrites the default build the default e2e serves.
    command: `npx vite build --outDir dist-reference --emptyOutDir && npx vite preview --outDir dist-reference --port ${appPort} --strictPort`,
    env: { VITE_FARDA_ADAPTER: "sandbox", VITE_FARDA_ADAPTER_BASE_URL: `http://localhost:${serverPort}` },
    url: `http://localhost:${appPort}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
