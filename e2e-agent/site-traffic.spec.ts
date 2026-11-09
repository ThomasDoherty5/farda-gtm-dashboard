import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { siteTrafficServerFixture, SYNTHETIC_TRAFFIC_MACHINE_TOKEN } from "../src/creator-agent/siteTrafficServerFixture.testkit.ts";
import { SYNTHETIC_READ_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";
import { digest } from "../src/creator-agent/config.ts";

let directory: string, fixture: ReturnType<typeof siteTrafficServerFixture>, app: ReturnType<typeof createAgentServer>;
const port = Number(process.env.E2E_AGENT_SERVER_PORT), base = `http://127.0.0.1:${port}`;
async function importSource() {
  const response = await fetch(base + "/v1/site-traffic/import", { method: "POST", headers: { authorization: `Bearer ${SYNTHETIC_TRAFFIC_MACHINE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(fixture.command) });
  expect(response.status, await response.text()).toBe(200);
}
test.beforeEach(async ({ page }) => {
  directory = mkdtempSync(join(tmpdir(), "traffic-browser-"));
  fixture = siteTrafficServerFixture(join(directory, "db.sqlite")); app = createAgentServer(fixture.options);
  await new Promise<void>(resolve => app.server.listen(port, "127.0.0.1", resolve));
  expect((await page.request.get("/v1/session", { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } })).ok()).toBe(true);
});
test.afterEach(async () => { await app.close(); fixture.close(); rmSync(directory, { recursive: true, force: true }); });

test("source-backed conversion, repeated events, segments and deep-link history preserve their exact measures", async ({ page }) => {
  await importSource(); await page.goto("/analytics/customer-journey");
  await expect(page.getByTestId("metric-sessions")).toHaveText("16,000");
  await expect(page.getByTestId("metric-conversion")).toHaveText("1.625%");
  await expect(page.getByText("Fictional test evidence · each metric keeps its own cohort", { exact: true })).toBeVisible();
  const selector = page.getByRole("combobox", { name: "Traffic segment" });
  const segment = await selector.locator("option").nth(1).getAttribute("value"); expect(segment).toBeTruthy();
  await selector.selectOption(segment!); await expect(page.getByTestId("metric-sessions")).toHaveText("3,000");
  await expect(page.getByTestId("metric-conversion")).toHaveText("1%");
  await page.reload(); await expect(selector).toHaveValue(segment!); await expect(page.getByTestId("metric-sessions")).toHaveText("3,000");
  await page.goBack(); await expect(page.getByTestId("metric-sessions")).toHaveText("16,000");
  await page.getByRole("button", { name: "Cohort definitions", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Repeated product-view or cart events never replace these denominators");
  await expect(page.getByRole("dialog")).toContainText("1%: converted sessions");
  await expect(page.getByRole("dialog")).toContainText("Fictional tests do not validate a live Shopify import");
});

test("missing, zero and partial traffic remain explicit without a fabricated zero conversion", async ({ page }) => {
  await page.goto("/analytics/customer-journey"); await expect(page.getByTestId("metric-sessions")).toHaveText("Unknown"); await expect(page.getByTestId("metric-conversion")).toHaveText("N/A");
  const partition = fixture.state.report.partitions[0]!;
  Object.assign(partition.rows[0]!.counters, { sessions: 0, cartSessions: 0, checkoutSessions: 0, completedCheckoutSessions: 0 });
  await importSource(); await page.reload(); await expect(page.getByTestId("metric-sessions")).toHaveText("0"); await expect(page.getByTestId("metric-conversion")).toHaveText("N/A");
  const partialThrough = new Date(Date.parse(partition.startAt) + 12 * 60 * 60_000).toISOString();
  Object.assign(partition, { revision: 2, coverage: "partial", replaceSegments: false, observedThrough: partialThrough, sourceAsOf: partialThrough });
  Object.assign(partition.rows[0]!.counters, { sessions: 1000, cartSessions: 100, checkoutSessions: 50, completedCheckoutSessions: 20 });
  fixture.command.input = { ...fixture.command.input, requestKey: "ref:" + digest("fictional-partial-key"), importRef: "ref:" + digest("fictional-partial-report") };
  await importSource(); await page.reload(); await expect(page.getByTestId("metric-sessions")).toHaveText("1,000");
  await expect(page.getByText(/Coverage: partial; freshness:/)).toBeVisible(); await expect(page.getByText(/260 Shopify orders ÷ 1,000 sessions · provisional/)).toBeVisible();
});

test("source denial in an open evidence dialog removes protected figures and daily rows", async ({ page }) => {
  await importSource(); await page.goto("/analytics/customer-journey"); await page.getByRole("button", { name: "Open commerce source", exact: true }).click();
  await expect(page.getByRole("table", { name: "Imported storefront daily aggregates" })).toBeVisible();
  fixture.state.denied = true; await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Current source evidence is unavailable");
  await expect(page.getByRole("table", { name: "Imported storefront daily aggregates" })).toHaveCount(0);
  await expect(page.getByTestId("metric-sessions")).toHaveCount(0);
  await expect(page.getByText("16,000", { exact: true })).toHaveCount(0);
});

test("unsupported reporting access is distinct from unconfigured access in the page and definitions", async ({ page }) => {
  fixture.state.capabilityState = "unsupported";
  await page.goto("/analytics/customer-journey");
  await expect(page.getByText("Shopify traffic access unsupported", { exact: true })).toBeVisible();
  await expect(page.getByTestId("metric-sessions")).toHaveText("Unknown");
  await expect(page.getByTestId("metric-conversion")).toHaveText("N/A");
  await page.getByRole("button", { name: "Cohort definitions", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("does not support the required Shopify traffic report");
  await expect(page.getByRole("dialog")).not.toContainText("Qualified Shopify account and reporting access pending");
  fixture.state.capabilityTransform = value => ({ ...value, definition: structuredClone(fixture.state.report.definition) });
  await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Shopify Analytics");
  await expect(page.getByRole("dialog")).toContainText("does not support the required Shopify traffic report");
  await page.keyboard.press("Escape");
  fixture.state.capabilityState = "unconfigured";
  fixture.state.capabilityTransform = null;
  await page.reload();
  await expect(page.getByText("Shopify traffic source pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Shopify traffic access unsupported", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cohort definitions", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Qualified Shopify account and reporting access pending");
});

test("expired publication leases retain labeled historical counts and withhold conversion", async ({ page }) => {
  await importSource(); await page.clock.install(); await page.goto("/analytics/customer-journey"); await expect(page.getByTestId("metric-conversion")).toHaveText("1.625%");
  await page.clock.fastForward(301_000);
  await expect(page.getByText("Retained source evidence", { exact: true })).toBeVisible();
  await expect(page.getByTestId("metric-conversion")).toHaveText("N/A"); await expect(page.getByTestId("metric-sessions")).toHaveText("16,000");
});

test("a source-version conflict immediately downgrades retained metrics before their previous lease expires", async ({ page }) => {
  await importSource(); await page.goto("/analytics/customer-journey"); await expect(page.getByTestId("metric-conversion")).toHaveText("1.625%");
  await page.getByRole("button", { name: "Open commerce source", exact: true }).click();
  fixture.state.beforeClicks = () => { fixture.state.sourceVersion = digest(fixture.state.sourceVersion + "changed"); };
  await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Retained · source no longer current");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("metric-conversion")).toHaveText("N/A");
  await expect(page.getByText("Retained source evidence", { exact: true })).toBeVisible();
});

test("performance definitions use the same source owner without changing financial or attribution scope", async ({ page }, info) => {
  await importSource(); await page.goto("/analytics/attribution");
  const trigger = page.getByRole("button", { name: "Metric definitions", exact: true });
  await expect(trigger).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`traffic-performance-pending-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await trigger.click(); await expect(page.getByRole("dialog", { name: "Metric definitions" })).toContainText("1.625%");
  await expect(page.getByRole("dialog")).toContainText("It does not change the financial reporting period or assign unattributed orders");
  await page.getByRole("link", { name: "Open traffic evidence", exact: true }).click();
  await expect(page).toHaveURL(/\/analytics\/customer-journey$/); await expect(page.getByTestId("metric-sessions")).toHaveText("16,000");
});

test("complete original-layout adaptation at three widths, keyboard definitions and actual daily-table screen-reader proof", async ({ page }, info) => {
  test.setTimeout(150_000); await importSource(); await page.goto("/analytics/customer-journey"); await expect(page.getByTestId("metric-conversion")).toHaveText("1.625%");
  await expect(page.getByRole("list", { name: "Support tickets by category" }).getByText("Unknown", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("list", { name: "Reviews by star rating" }).getByText("Unknown", { exact: true })).toHaveCount(5);
  for (const label of ["Shopify net receipts", "Shopify AOV", "Quarantined from inspected"]) await expect(page.getByText(label, { exact: true })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`traffic-complete-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(node => node.target) }))).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const trigger = page.getByRole("button", { name: "Cohort definitions", exact: true }); await trigger.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Cohort definitions" })).toBeVisible(); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await screenReaderCheckpoint(page, "traffic-definitions-focus-return", trigger, ["Cohort definitions", "button"]);
  await page.getByRole("button", { name: "Open commerce source", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const dailyRegion = page.getByRole("region", { name: "Imported storefront daily aggregates" });
  expect(await dailyRegion.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await dailyRegion.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await dailyRegion.evaluate(element => element.scrollLeft > 0)).toBe(true);
  await dailyRegion.evaluate(element => { element.scrollLeft = 0; });
  await page.screenshot({ path: info.outputPath("traffic-source-dialog-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenReaderCheckpoint(page, "traffic-daily-table-headers", page.getByRole("region", { name: "Imported storefront daily aggregates" }), ["Imported storefront daily aggregates", "Calendar day", "Sessions", "Revision"], "KP_Enter");
});
