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
let financeClock = fixedNow;
const routes = ["/finance", "/finance/commissions", "/finance/settlements/COMM-DEMO-D", "/finance/payables/PAY-0012", "/finance/close/2026-10",
  "/finance/close/2026-10?view=months", "/finance/close/2026-10?view=manifest", "/analytics/finance"];

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: fixedNow });
  settlement = originalLayoutFinanceSource(scope, fixedNow);
  mode = "unconfigured";
  financeClock = fixedNow;
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => financeClock },
    settlements: { source: settlement.source },
    financeSource: financeTestSource(async (_scope, request) => {
      if (mode === "denied") throw new FinanceError("DENIED", 403);
      return { ...financeSnapshot(request.viewKey, {}, financeClock), scope: { ...scope } };
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

  // The legacy financial report has its own access grant, independent of the
  // rich settlement reader above. Resuming a suspended tab cannot retain it.
  mode = "configured";
  await page.goto("/finance");
  await expect(page.getByTestId("pnl")).toBeVisible();
  await page.getByRole("button", { name: "View metric definitions" }).click();
  const definitions = page.getByRole("dialog", { name: "Metric definitions" });
  await expect(definitions).toBeVisible();
  await screenReaderCheckpoint(page, "native-finance-metric-definitions", definitions, ["Metric definitions", "Why provisional", "Creator-cost coverage"]);
  financeClock = fixedNow + 15 * 60_000;
  await page.clock.setSystemTime(financeClock);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("Source access has expired. Refresh to verify the current evidence.")).toBeVisible();
  await expect(page.getByTestId("pnl")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh source evidence" }).click();
  await expect(page.getByTestId("pnl")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});


test("native ledger header controls remain inside their panels at desktop, tablet and mobile widths", async ({ page }, testInfo) => {
  await login(page);
  await page.goto("/finance/commissions?provider=collabs");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const title of ["Accrued expense and cash are different.", "Contribution after creator costs"]) {
      const panel = page.getByRole("region", { name: title, exact: true });
      await expect(panel).toBeVisible();
      const header = panel.locator(":scope > div").first();
      const controls = header.getByRole("button").or(header.getByRole("link"));
      expect(await controls.count()).toBeGreaterThan(0);
      const diagnostic = await header.evaluate(element => {
        const boundsOf = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
        const style = getComputedStyle(element);
        return { panel: boundsOf(element.parentElement!), header: boundsOf(element), display: style.display, columns: style.gridTemplateColumns,
          controls: Array.from(element.querySelectorAll("button, a")).map(control => { const css = getComputedStyle(control); return {
            name: control.getAttribute("aria-label") ?? control.textContent?.trim(), bounds: boundsOf(control), minWidth: css.minWidth, maxWidth: css.maxWidth, flexBasis: css.flexBasis,
          }; }) };
      });
      await testInfo.attach(`header-geometry-${width}-${title.startsWith("Accrued") ? "ledger" : "contribution"}`, { body: JSON.stringify({ viewport: width, title, ...diagnostic }, null, 2), contentType: "application/json" });
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      for (const control of await controls.all()) {
        await expect(control).toBeVisible();
        const rect = await control.boundingBox();
        expect(rect).not.toBeNull();
        const context = `${width}px / ${title} / ${(await control.getAttribute("aria-label")) ?? (await control.innerText())}`;
        expect(rect!.x, `${context}: left edge`).toBeGreaterThanOrEqual(bounds!.x);
        expect(rect!.x + rect!.width, `${context}: right edge`).toBeLessThanOrEqual(bounds!.x + bounds!.width);
        expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (width === 1440) expect(rect!.height).toBeLessThanOrEqual(45);
      }
      if (width === 1440) {
        const heading = await panel.getByRole("heading", { name: title, exact: true }).boundingBox();
        const firstControl = await controls.first().boundingBox();
        expect(Math.abs(heading!.y - firstControl!.y)).toBeLessThanOrEqual(1);
      }
    }
  }
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
  const cohortEvidence = page.getByRole("button", { name: "Cohort evidence", exact: true });
  await cohortEvidence.click();
  const cohortDialog = page.getByRole("dialog", { name: "Contribution cohort evidence", exact: true });
  await expect(cohortDialog).toContainText(/cohort-[a-f0-9]{24}/);
  await expect(cohortDialog).not.toContainText("layout-four-commission-groups");
  await expect(cohortDialog).toContainText("Eligible orders");
  await expect(cohortDialog).toContainText("Accounting policy");
  await expect(cohortDialog).toContainText("USD");
  await screenReaderCheckpoint(page, "native-contribution-cohort-dialog", cohortDialog, ["Contribution cohort evidence", "Cohort", "Period", "Accounting policy"]);
  await page.keyboard.press("Escape");
  await expect(cohortEvidence).toBeFocused();
  await screenReaderCheckpoint(page, "native-contribution-cohort-focus-return", cohortEvidence, ["Cohort evidence"]);
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
    if(index===0){
      const activation=page.getByRole("button",{name:"View activation exception",exact:true});
      await activation.click();
      const dialog=page.getByRole("dialog",{name:"Creator payout activation evidence",exact:true});
      await expect(dialog).toContainText("No creator-activation exception observations were returned");
      await page.keyboard.press("Escape");await expect(activation).toBeFocused();
    }else{
      const history=page.getByRole("button",{name:"Review historical terms",exact:true});
      await history.click();
      await expect(page.getByRole("dialog",{name:"Historical accepted terms",exact:true})).toContainText("Original source receipts");
      await page.keyboard.press("Escape");await expect(history).toBeFocused();
      await page.getByRole("link",{name:"Samples",exact:true}).click();
      const inspect=page.getByRole("button",{name:/^Inspect sample evidence for /});
      await inspect.click();
      const sample=page.getByRole("dialog",{name:"Independent sample source evidence",exact:true});
      await expect(sample).toContainText("Acceptance");await expect(sample).toContainText("Stock");await expect(sample).toContainText("Fulfillment");
      await expect(sample).toContainText("not observed");
      expect((await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");await expect(inspect).toBeFocused();
    }
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
