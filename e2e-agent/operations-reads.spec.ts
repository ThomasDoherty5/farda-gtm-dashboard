import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { OperationsReadError } from "../src/creator-agent/operationsReads/source.ts";
import { operationsTestSource, operationsSnapshot, syntheticCustomer, syntheticAuditReason } from "../src/creator-agent/operationsReads/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";

const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
let app: ReturnType<typeof createAgentServer>;
let mode: "configured" | "denied" = "configured";
const routes = ["/operations", "/orders/TEST-SH-1042", "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129", "/returns/TEST-RET-028",
  "/analytics/fulfillment", "/analytics/fulfillment?view=health"];
const listen = () => new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });

test.beforeEach(async () => {
  mode = "configured";
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => Date.parse("2026-11-06T12:00:00.000Z") },
    operationsReadSource: operationsTestSource(async (_scope, request) => {
      if (mode === "denied") throw new OperationsReadError("DENIED", 403);
      return { ...operationsSnapshot(request.viewKey), scope: { ...scope } };
    }) });
  await listen();
});
test.afterEach(async () => { await app.close(); });
async function login(page: Page, reviewer = false) {
  expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + (reviewer ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN) } })).ok()).toBe(true);
}

test("operations screens show an honest unavailable state, never demo figures, when the operations source is not connected", async ({ page }) => {
  test.setTimeout(120_000);
  // The injected reader exists only to prove the other states below; this case uses a server with none.
  await app.close();
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN });
  await listen();
  await login(page);
  for (const route of routes) {
    await page.goto(route);
    const alert = page.getByRole("alert").filter({ hasText: "Data unavailable" });
    await expect(alert, route).toBeVisible();
    for (const demo of ["$", "Synthetic data", "Waiting for shipment", "Shipment marked lost", "Home H1", "Testville"])
      await expect(page.getByText(demo, { exact: false }), `${route} ${demo}`).toHaveCount(0);
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), route).toEqual([]);
  }
});

test("a configured source renders a validated order without customer details for a reader, and a later source denial clears it", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/orders/TEST-SH-1042");
  await expect(page.getByRole("heading", { name: "Order TEST-SH-1042" })).toBeVisible();
  await expect(page.getByText("Waiting for shipment · 2.4 days")).toBeVisible();
  await page.getByRole("button", { name: "Customer details (restricted)" }).click();
  await expect(page.getByTestId("customer-denied")).toBeVisible();
  await expect(page.getByTestId("customer-revealed")).toHaveCount(0);
  for (const value of Object.values(syntheticCustomer)) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
  await page.keyboard.press("Escape");
  mode = "denied";
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "No access to this account" })).toBeVisible();
  await expect(page.getByText("Waiting for shipment · 2.4 days")).toHaveCount(0);
});

test("a reviewer cannot disclose customer details or prior private audit text while reveal authority is held", async ({ page }) => {
  await login(page, true);
  await page.goto("/orders/TEST-SH-1042");
  await page.getByRole("button", { name: "Customer details (restricted)" }).click();
  await expect(page.getByTestId("customer-denied")).toBeVisible();
  await expect(page.getByTestId("customer-revealed")).toHaveCount(0);
  await expect(page.getByTestId("customer-audit")).toHaveCount(0);
  for (const value of [...Object.values(syntheticCustomer), syntheticAuditReason])
    await expect(page.getByText(value, { exact: false })).toHaveCount(0);
});
