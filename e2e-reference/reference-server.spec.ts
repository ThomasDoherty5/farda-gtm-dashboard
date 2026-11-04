import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * The built app (VITE_FARDA_ADAPTER=sandbox, base URL baked in) against the REFERENCE SERVER, a test double. It checks the
 * real HTTP path and the honest failure. It is not integration verification: no production backend exists (THO-283 is open).
 */
const appPort = Number(process.env.E2E_REF_APP_PORT ?? 4181);
const serverPort = Number(process.env.E2E_REF_SERVER_PORT ?? 8788);
const server = `http://localhost:${serverPort}`;

let child: ChildProcess | null = null;
async function startServer() {
  child = spawn(process.execPath, ["tools/reference-server/run.mjs"], {
    env: { ...process.env, NODE_ENV: "development", REFERENCE_SERVER_PORT: String(serverPort), REFERENCE_SERVER_ORIGINS: `http://localhost:${appPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The reference server did not start in 60 s.")), 60_000);
    child!.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Listening on")) { clearTimeout(timer); resolve(); } });
    child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`The reference server exited early (${code}).`)); });
  });
}
async function stopServer() {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>((resolve) => { c.once("exit", () => resolve()); c.kill("SIGTERM"); });
}
test.afterEach(stopServer);

test("the Overview loads over HTTP from the reference server, then shows the honest unavailable state when it stops, with no demo data", async ({ page, context }) => {
  await startServer();
  // The fake dev sign-in sets an HttpOnly cookie on localhost, shared with the app because the host is the same.
  const signedIn = await context.request.get(`${server}/dev/sign-in?user=founder`);
  expect(signedIn.ok()).toBe(true);
  expect(await context.cookies(server)).toEqual([expect.objectContaining({ name: "farda_ref_session", httpOnly: true, sameSite: "Lax" })]);

  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().startsWith(server) && r.method() === "POST") reads.push(r.url()); });
  await page.goto("/overview");
  await expect(page.getByTestId("metric-Paid orders")).toHaveText(/400/);
  await expect(page.getByTestId("metric-Net receipts")).toContainText("$12,596");
  expect(reads).toContain(`${server}/v1/read`);
  // The app holds no token: no browser storage entry, and the session cookie is not readable from the page.
  expect(await page.evaluate(() => ({ local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie }))).toEqual({ local: 0, session: 0, cookie: "" });

  await stopServer();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Data unavailable" })).toBeVisible();
  // No demo data fills the gap: no metric, no number from the fixture, and nothing labeled Demo.
  await expect(page.getByTestId("metric-Paid orders")).toHaveCount(0);
  await expect(page.locator("[data-testid^='metric-']")).toHaveCount(0);
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/12,596|\b400\b|240\.0k/);
  expect(text).not.toMatch(/\bDemo\b/);
});

test("without a session the app shows the sign-in-needed state, not data", async ({ page }) => {
  await startServer();
  await page.goto("/overview");
  await expect(page.locator("[data-testid^='metric-']")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
});
