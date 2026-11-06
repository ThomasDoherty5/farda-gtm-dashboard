import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type CapabilityRegistration, type VerificationReceipt } from "../src/creator-agent/connections/schema.ts";
import { POLICY_VERSION } from "../src/creator-agent/assessmentSchema.ts";

const port = Number(process.env.E2E_AGENT_SERVER_PORT);
const base = `http://127.0.0.1:${port}`;
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
const registration: CapabilityRegistration = { binding: { ...scope, provider: "zapier", providerAccountId: "synthetic-private-provider-account", action: "readPolicy",
  mode: "observe", route: "api", routeRef: "route:synthetic-private", authorizationScopeVersion: "v1", toolVersion: "v1", requiredScopes: ["readHealth"],
  connectionRef: "connection:synthetic-private", secretRef: "secretref:synthetic-private" }, ownerRef: "owner:synthetic-private", costBasis: { state: "unknown", reasonCode: "NOT_MEASURED" } };
let app: ReturnType<typeof createAgentServer>;
let now: number;
let receipt: VerificationReceipt | null;
test.beforeEach(async () => {
  now = Date.parse("2026-11-04T16:00:00Z"); receipt = null;
  app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...scope,
    operations: { now: () => now, resolveReceipt: () => receipt } });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(port, "127.0.0.1", resolve); });
});
test.afterEach(async () => { if (app) await app.close(); });
async function write(path: string, body: unknown) {
  const response = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json", "idempotency-key": "synthetic-browser-event" }, body: JSON.stringify(body) });
  expect(response.status, path).toBe(200);
  return (await response.json()).data;
}
async function signIn(page: Page) {
  expect((await page.request.get("/v1/session", { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } })).ok()).toBe(true);
}

test("reads saved permissions, separates source freshness, and rechecks expiry through actual HTTP", async ({ page }) => {
  const record = await write("/v1/connections/register", { registration, expectedRevision: 0 });
  receipt = { receiptRef: "receipt:synthetic-private", binding: registration.binding, outcome: "Ready", checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    verifiedScopes: ["readHealth"], connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] };
  await write("/v1/connections/" + record.capabilityId + "/verify", { receiptRef: receipt.receiptRef, expectedRevision: 1 });
  await signIn(page);
  await page.goto("/settings/connections");
  const panel = page.getByTestId("saved-bindings");
  await expect(panel).toContainText("Showing 1 of 1 saved bindings.");
  await expect(panel.getByText("Ready", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Inspect binding" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Binding evidence" });
  await expect(dialog).toContainText("Last successful source read");
  await expect(dialog).toContainText("Unknown");
  await expect(dialog).not.toContainText("synthetic-private");
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Inspect binding" })).toBeFocused();
  now += 60_000;
  await page.getByRole("button", { name: "Check connections" }).click();
  await expect(panel.getByText("Expired", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Inspect available actions" }).click();
  await expect(page.getByTestId("saved-bindings")).toContainText("Expired");
  const violations = (await new AxeBuilder({ page: page as never }).analyze()).violations;
  expect(violations.map(item => item.id)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("saved-bindings").getByRole("button", { name: "Inspect binding" }).click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeInViewport();
  await page.screenshot({ path: ".handoff/figma/settings-live-binding-mobile.png" });
  await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(dialog.getByText("Setup and permission changes require authorization in the owning system.")).toBeInViewport();
  await expect(close).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollTop > 0)).toBe(true);
  await page.screenshot({ path: ".handoff/figma/settings-live-binding-mobile-bottom.png" });
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Inspect binding" })).toBeFocused();
});

test("displays actual saved run correlation in its read-only trace and no fabricated schedule links", async ({ page }) => {
  const definition = { jobId: "synthetic-private-job", version: 1, ownerRef: "synthetic-owner", mode: "observe", handler: "record-reference.v1", eventType: "synthetic-private-event",
    inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1", policyVersion: POLICY_VERSION, modelVersion: null, offerVersion: null, capabilityBinding: null,
    budgets: { maxItems: 5, maxSteps: 10, maxAttempts: 1, maxRunMs: 60_000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 } };
  await write("/v1/jobs/register", { definition, expectedVersion: 0 });
  await write("/v1/jobs/ingress", { schemaVersion: "job-reference-batch.v1", jobId: definition.jobId, jobVersion: 1, eventId: "synthetic-private-correlation", eventType: definition.eventType, eventAt: null,
    items: [{ itemKey: "synthetic-item", subjectRef: "synthetic-subject", evidenceRef: null }] });
  await signIn(page);
  await page.goto("/automations");
  await expect(page.getByTestId("saved-runs")).toContainText("Showing 1 of 1 saved runs.");
  await page.getByRole("button", { name: "Inspect run" }).click();
  const dialog = page.getByRole("dialog", { name: "Saved run trace" });
  await expect(dialog).toContainText("JOB_DISABLED_OR_STALE");
  await expect(dialog).toContainText(/event-[a-f0-9]{16}/);
  await expect(dialog).not.toContainText("synthetic-private");
  expect(new URL(page.url()).searchParams.get("run")).toMatch(/^run-[a-f0-9]{16}$/);
  await page.keyboard.press("Escape");
  await expect(page.locator("main a[href*='demo-']")).toHaveCount(0);
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: ".handoff/figma/settings-live-runs-desktop.png", fullPage: true });
  await page.goto("/automations?tab=zaps");
  await expect(page.getByRole("region", { name: "Saved job definitions" })).toContainText("Disabled");
  await page.goto("/automations?tab=reporting");
  await expect(page.getByText(/Report destinations and delivery schedules are unavailable/)).toBeVisible();
});

test("describes an empty local ledger and clears its saved values when reader access is lost", async ({ page, context }) => {
  await signIn(page);
  await page.goto("/settings/connections");
  await expect(page.getByTestId("saved-bindings")).toContainText("Provider coverage is unknown");
  await write("/v1/connections/register", { registration, expectedRevision: 0 });
  await page.getByRole("button", { name: "Check connections" }).click();
  await expect(page.getByTestId("saved-bindings")).toContainText("Read policy");
  await context.clearCookies();
  await page.getByRole("button", { name: "Check connections" }).click();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Read policy");
});
