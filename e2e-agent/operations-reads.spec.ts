import { originalLayoutOperationsSource } from "./support/original-layout-operations-source.ts";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { OperationsReadError } from "../src/creator-agent/operationsReads/source.ts";
import { operationsTestSource, operationsSnapshot, syntheticCustomer, syntheticAuditReason } from "../src/creator-agent/operationsReads/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";

import { captureFinanceOperations } from "./support/finance-operations-captures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
let app: ReturnType<typeof createAgentServer>;
let returnResolved = false;
let originalLayout = false;
let mode: "configured" | "denied" = "configured";
const routes = ["/operations", "/orders/TEST-SH-1042", "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129", "/returns/TEST-RET-028",
  "/analytics/fulfillment", "/analytics/fulfillment?view=health"];
const listen = () => new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: Date.parse("2026-11-06T12:00:00.000Z") });
  returnResolved = false;
  originalLayout = false;
  mode = "configured";
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => Date.parse("2026-11-06T12:00:00.000Z") },
    operationsReadSource: operationsTestSource(async (_scope, request) => {
      if (mode === "denied") throw new OperationsReadError("DENIED", 403);
      const snapshot = originalLayout ? originalLayoutOperationsSource(request.viewKey, request.filters, returnResolved) : operationsSnapshot(request.viewKey);
      if (!originalLayout && request.viewKey === "operationsOverview") {
        snapshot.record.reportingScope = { home: "all", startAt: "2026-11-01T00:00:00.000Z", endAt: "2026-11-07T00:00:00.000Z", timezone: "UTC", basis: "requestedAt" };
        snapshot.record.queue = { rows: [{ ref: "TEST-SH-1042", kind: "order", home: "H1", waitingHours: 57.6, units: 1, hold: null,
          sourceFacts: { requestedAt: "2026-11-04T02:24:00.000Z", orderRef: "TEST-SH-1042", sampleRef: null, shipmentRef: null, detailRef: "TEST-SH-1042", orderUnfulfilled: true, sampleApproved: null, labelCreated: false, canceled: false, identityResolved: true, stockAvailable: true, evidenceRef: "synthetic-dispatch-evidence", observedAt: "2026-11-06T11:55:00.000Z" } }], total: 1 };
      }
      if (!originalLayout && request.viewKey === "returnDetail" && returnResolved) {
        snapshot.version = "synthetic-resolved-v2";
        snapshot.record.state = "resolved";
        snapshot.record.nativeEvents = ["returnReceived", "inventoryQuarantined", "refundSettled", "accountingPosted", "caseClosed"].map(kind => ({ kind, state: "confirmed", eventAt: "2026-11-06T11:50:00.000Z", observedAt: "2026-11-06T11:55:00.000Z", receiptRef: `synthetic-${kind}-receipt`, sourceRef: `synthetic-${kind}-source`, reasonCode: null }));
        snapshot.record.resolved = { chain: [{ outcome: "Refund settled", receipt: "synthetic-refundSettled-receipt", confirmedAt: "2026-11-06T11:50:00.000Z" }], refunded: { minorUnits: 4000, currency: "USD" }, returnedUnits: 1, restockedUnits: 0, retainedUnits: 1, replacement: "Not requested", caseRef: "synthetic-closed-case" };
      }
      return { ...snapshot, scope: { ...scope } };
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

test("a configured source renders a validated order without customer details for a reader, and a later source denial clears it", async ({ page }, info) => {
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
  await page.screenshot({ path: info.outputPath("native-order-unknown-held.png"), fullPage: true });
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


test("native operations captures every original frame and preserves privacy and keyboard recovery", async ({ page }) => {
  test.setTimeout(240_000);
  originalLayout = true;
  await login(page);
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Operations", exact: true })).toBeVisible();
  const readyOrder = page.getByRole("region", { name: "Ready to leave home", exact: true }).getByRole("row").filter({ hasText: "TEST-SH-1042" });
  const orderLink = readyOrder.getByRole("link", { name: "View order", exact: true });
  await expect(orderLink).toBeVisible();
  const orderTarget = new URL((await orderLink.getAttribute("href"))!, "https://example.test");
  expect(orderTarget.pathname).toBe("/orders/TEST-SH-1042");
  expect(orderTarget.searchParams.get("home")).toBe("all");
  expect(orderTarget.searchParams.get("startAt")).toBe("2026-11-01T00:00:00.000Z");
  expect(orderTarget.searchParams.get("endAt")).toBe("2026-11-07T00:00:00.000Z");
  expect(orderTarget.searchParams.get("timezone")).toBe("UTC");
  await captureFinanceOperations(page, "4:6");
  await page.goto("/operations?home=H2&startAt=2026-11-01T00%3A00%3A00.000Z&endAt=2026-11-07T00%3A00%3A00.000Z&timezone=UTC");
  await expect(page.getByTestId("metric-To ship")).toContainText("6");
  await captureFinanceOperations(page, "12:653");
  await page.goto("/operations");
  await expect(page.getByTestId("metric-To ship")).toContainText("18");
  await captureFinanceOperations(page, "12:708");
  await page.setViewportSize({ width: 1440, height: 1452 });
  const queue = page.getByTestId("queue-table");
  await screenReaderCheckpoint(page, "native-dispatch-table-headers", queue, ["Order", "sample", "Home", "Waiting", "Next action"]);
  await page.goto("/orders/TEST-SH-1042");
  await expect(page.getByRole("heading", { name: "Order TEST-SH-1042" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Customer details (restricted)", exact: true })).toBeVisible();
  await captureFinanceOperations(page, "4:171");
  const customer = page.getByRole("button", { name: "Customer details (restricted)", exact: true });
  await customer.click();
  await expect(page.getByTestId("customer-denied")).toBeVisible();
  await expect(page.getByTestId("customer-revealed")).toHaveCount(0);
  for (const value of [...Object.values(syntheticCustomer), syntheticAuditReason]) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(customer).toBeFocused();
  await screenReaderCheckpoint(page, "native-customer-denial-focus-return", customer, ["Customer details", "restricted"]);
  for (const [route, node, title] of [
    ["/shipments/TEST-SP-0093/exceptions/TEST-EVT-129", "4:317", "Shipment TEST-SP-0093"],
    ["/returns/TEST-RET-028", "12:292", "Return TEST-RET-028"],
    ["/analytics/fulfillment", "12:808", "Fulfillment"],
  ] as const) {
    await page.goto(route);
    await expect(page.getByRole("heading").filter({ hasText: title }).first()).toBeVisible();
    await expect(page.getByText("Synthetic source evidence", { exact: false }).first()).toBeVisible();
    await captureFinanceOperations(page, node);
    expect((await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
  returnResolved = true;
  await page.goto("/returns/TEST-RET-028");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Return resolved", exact: true })).toBeVisible();
  await captureFinanceOperations(page, "12:431");
  await expect(page.getByTestId("return-chain").getByRole("row").filter({hasText:"TEST-RC-2"})).toBeVisible();
  await page.clock.fastForward(601_000);
  await expect(page.getByRole("heading", { name: "Return resolved", exact: true })).toHaveCount(0);
  await expect(page.getByText(/TEST-RC-2/)).toHaveCount(0);
});
