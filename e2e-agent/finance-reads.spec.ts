import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { FinanceError } from "../src/creator-agent/finance/source.ts";
import { financeTestSource, financeSnapshot } from "../src/creator-agent/finance/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";

import { originalLayoutFinanceSource } from "./support/original-layout-finance-source.ts";
import { captureFinanceOperations } from "./support/finance-operations-captures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

const fixedNow = Date.parse("2026-11-06T12:00:00.000Z");
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
let settlement: ReturnType<typeof originalLayoutFinanceSource>;
let app: ReturnType<typeof createAgentServer>;
let mode: "unconfigured" | "configured" | "denied" = "unconfigured";
const routes = ["/finance", "/finance/commissions", "/finance/settlements/COMM-DEMO-D", "/finance/payables/PAY-0012", "/finance/close/2026-10",
  "/finance/close/2026-10?view=months", "/finance/close/2026-10?view=manifest", "/analytics/finance"];

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: fixedNow });
  settlement = originalLayoutFinanceSource(scope, fixedNow);
  mode = "unconfigured";
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => Date.parse("2026-11-06T12:00:00.000Z") },
    settlements: { source: settlement.source },
    financeSource: financeTestSource(async (_scope, request) => {
      if (mode === "denied") throw new FinanceError("DENIED", 403);
      return { ...financeSnapshot(request.viewKey), scope: { ...scope } };
    }) });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
});
test.afterEach(async () => { await app.close(); });
async function login(page: Page, reviewer = false) {
  expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + (reviewer ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN) } })).ok()).toBe(true);
}

test("finance screens show an honest unavailable state, never figures, when the finance source is not connected", async ({ page }) => {
  test.setTimeout(120_000);
  // The injected reader exists only to prove the other states below; this case uses a server with none.
  await app.close();
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
  await login(page);
  for (const route of routes) {
    await page.goto(route);
    const alert = page.getByRole("alert").filter({ hasText: "Data unavailable" });
    await expect(alert, route).toBeVisible();
    await expect(page.getByText("$", { exact: false }), route).toHaveCount(0);
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), route).toEqual([]);
  }
});

test("a configured source renders validated finance data, and a later source denial clears it", async ({ page }) => {
  test.setTimeout(90_000);
  mode = "configured";
  await login(page);
  await page.goto("/finance/commissions");
  await page.getByRole("link", { name: /Open historical payable/ }).click();
  await expect(page.getByRole("heading", { name: "Direct content fees end with proof." })).toBeVisible();
  await expect(page.getByText(/The accepted USD\s150\.00 obligation/)).toBeVisible();
  mode = "denied";
  settlement.state.denied = true;
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "No access to this account" })).toBeVisible();
  await expect(page.getByText(/The accepted USD\s150\.00 obligation/)).toHaveCount(0);
});


test("native ledger and every settlement frame retain evidence, held authority and full-page accessibility", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await page.goto("/finance/commissions?provider=collabs");
  await expect(page.getByRole("heading", { name: "Every commission, accounted for." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Contribution waterfall", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Commission and historical obligation records", exact: true }).getByRole("row")).toHaveCount(5);
  await expect(page.getByRole("table", { name: "Commission and historical obligation records", exact: true })).toContainText("Awaiting provider");
  await captureFinanceOperations(page, "65:1037");
  const accessibleTable = page.getByRole("button", { name: "Accessible table", exact: true });
  await accessibleTable.click();
  await expect(accessibleTable).toHaveAttribute("aria-pressed", "true");
  await screenReaderCheckpoint(page, "native-contribution-table-control", accessibleTable, ["Accessible table"]);
  await expect(page.getByRole("table", { name: "Source contribution components", exact: true })).toBeVisible();
  const chart = page.getByRole("button", { name: "Chart", exact: true });
  await chart.click();
  await expect(chart).toHaveAttribute("aria-pressed", "true");
  await screenReaderCheckpoint(page, "native-contribution-chart-control", chart, ["Chart"]);
  const ledger = page.getByRole("region", { name: "Commission and historical obligation records" });
  await screenReaderCheckpoint(page, "native-ledger-table-headers", ledger, ["Record", "Gross earned", "Reversed", "Net accrued", "Current source state", "Next action"]);
  const exportButton = page.getByRole("button", { name: "Export ledger", exact: true });
  await exportButton.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(exportButton).toBeFocused();
  await screenReaderCheckpoint(page, "native-ledger-export-focus-return", exportButton, ["Export ledger"]);
  await page.goto("/finance/commissions");
  await expect(page.getByRole("link", { name: /Open historical payable/ })).toBeVisible();
  const allDetails = await page.getByRole("link", { name: /^Open settlement/ }).evaluateAll(links => links.map(link => (link as HTMLAnchorElement).getAttribute("href")!));
  expect(allDetails).toHaveLength(5);
  const details = [allDetails[3]!, allDetails[4]!];
  const payable = await page.getByRole("link", { name: /Open historical payable/ }).getAttribute("href");
  expect(details).toHaveLength(2);
  for (const [index, route] of details.entries()) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Synthetic source evidence", { exact: false }).first()).toBeVisible();
    await captureFinanceOperations(page, index === 0 ? "66:252" : "66:447");
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations).toEqual([]);
  }
  expect(payable).toBeTruthy();
  await page.goto(payable!);
  await expect(page.getByRole("heading", { name: "Direct content fees end with proof." })).toBeVisible();
  await captureFinanceOperations(page, "9:551");
  const evidence = page.getByRole("button", { name: "Inspect source evidence", exact: true });
  await evidence.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close evidence", exact: true }).click();
  await expect(evidence).toBeFocused();
  await screenReaderCheckpoint(page, "native-payable-evidence-focus-return", evidence, ["Inspect source evidence"]);
  expect((await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.clock.fastForward(301_000);
  await expect(page.getByRole("alert").filter({ hasText: "expired" })).toBeVisible();
  await expect(page.getByText(/The accepted USD\s150\.00 obligation/)).toHaveCount(0);
});
