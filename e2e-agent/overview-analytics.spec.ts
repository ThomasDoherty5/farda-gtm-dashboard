import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { analyticsTestScope } from "../src/creator-agent/analytics/fixtures.testkit.ts";
import { nativeAnalyticsFixture } from "../src/creator-agent/analytics/nativeFixtures.testkit.ts";
import type { NativeAnalyticsSnapshot } from "../src/creator-agent/analytics/contract.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

/** Actual HTTP/SQLite with fictional, source-qualified permissions, never live provider proof. */
const options = { databasePath: ":memory:", workspaceId: analyticsTestScope.workspaceId, accountId: analyticsTestScope.accountId,
  readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN };
async function listen(app: ReturnType<typeof createAgentServer>) {
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
}
async function login(page: Page) { expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).ok()).toBe(true); }
async function accessible(page: Page) {
  const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
}
function configured(mutate?: (snapshot: NativeAnalyticsSnapshot) => void) {
  const fixture = nativeAnalyticsFixture({ now: Date.now, principalRef: "agent-reader" });
  fixture.state.mutate = packet => { packet.validUntil = new Date(Date.parse(packet.observedAt) + 600_001).toISOString(); for (const owner of packet.owners) owner.validUntil = packet.validUntil; mutate?.(packet); };
  return { fixture, app: createAgentServer({ ...options, analyticsSource: fixture.source }) };
}

test("unconnected sources show a typed hold, never demo, zero or successful empty", async ({ page }) => {
  const app = createAgentServer(options); await listen(app);
  try {
    await login(page); const unavailable = page.waitForResponse(response => response.url().endsWith("/v1/read") && response.status() === 503); await page.goto("/overview");
    expect((await (await unavailable).json()).code).toBe("ANALYTICS_SOURCE_UNCONFIGURED");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Data unavailable", exact: true })).toBeVisible();
    for (const key of ["Net receipts", "Paid orders"]) await expect(page.getByTestId(`metric-${key}`)).toHaveCount(0);
    for (const figure of ["$12,596", "Demo performance", "Illustrative figures"]) await expect(page.getByText(figure, { exact: false })).toHaveCount(0);
    await accessible(page);
  } finally { await app.close(); }
});

test("served orders retain original arithmetic and missing-source distinctions, including stale observations", async ({ page }) => {
  let staleOrders = false;
  const { app } = configured(packet => {
    if (packet.viewKey !== "overviewSummary") return;
    packet.facts.economics = null; packet.facts.posts = []; packet.facts.postsTotal = { value: null, reason: "SOURCE_MISSING", proofRef: null, evidenceRefs: [] };
    if (staleOrders) { const old = new Date(Date.now() - 20 * 60_000).toISOString(); packet.facts.orders!.snapshot.feeds[0]!.lastSuccessAt = old; packet.owners.find(owner => owner.owner === "commerceOrders")!.sourceAsOf = old; }
  }); await listen(app);
  try {
    await login(page); await page.goto("/overview");
    await expect(page.getByTestId("metric-Net receipts")).toHaveText("$12,596.00");
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
    await expect(page.getByText("$31.49 average net receipts")).toBeVisible();
    for (const key of ["Contribution", "Marketing efficiency", "Blended CAC", "Views"]) await expect(page.getByTestId(`metric-${key}`)).toHaveText("Unknown");
    await expect(page.getByTestId("metric-Contribution").locator("[title]")).toHaveAttribute("title", "COST_INCOMPLETE");
    // 180 code orders include20 sitewide promotion orders; only160 belong to creators.
    await expect(page.getByTestId("metric-Attributed orders")).toHaveText("160");
    await expect(page.getByText("Demo performance")).toHaveCount(0); await accessible(page);
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
    staleOrders = true; await page.getByRole("button", { name: "Refresh reporting evidence", exact: true }).click();
    await expect(page.getByTestId("metric-Net receipts")).toContainText("$12,596.00");
    await expect(page.getByTestId("metric-Net receipts")).toContainText("provisional");
  } finally { await app.close(); }
});

test("an exact source period persists into performance and invalid deep links never silently rebase", async ({ page }) => {
  const { app } = configured(); await listen(app);
  try {
    await login(page); await page.goto("/overview");
    await page.getByRole("button", { name: "Reporting period", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "A consistent reporting window." });
    await dialog.getByLabel("Reporting start", { exact: true }).fill("2026-10-01T00:00:00Z");
    await dialog.getByLabel("Reporting end (exclusive)").fill("2026-10-08T00:00:00Z"); await dialog.getByLabel("Reporting timezone").fill("UTC");
    await dialog.getByRole("button", { name: "Apply reporting period" }).click(); await expect(page).toHaveURL(/report-start=/);
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
    await page.getByRole("button", { name: "Reporting period", exact: true }).click(); await dialog.getByRole("link", { name: "View analytics workspace" }).click();
    await expect(page).toHaveURL(/analytics\/attribution\?report-start=/); await expect(page.getByTestId("metric-net-receipts")).toContainText("$12,596.00");
    const invalid = page.waitForResponse(response => response.url().endsWith("/v1/read") && response.status() === 400);
    await page.goto("/overview?report-start=invalid"); expect((await (await invalid).json()).code).toBe("INVALID_INPUT"); await expect(page.getByTestId("metric-Net receipts")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Check this request", exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("permission denial and exact lease expiry clear reporting rows and source details", async ({ page }) => {
  const { app, fixture } = configured(); await listen(app);
  try {
    await login(page); await page.goto("/analytics/paid-media"); const table = page.getByRole("table", { name: "Paid channel metrics" }); await expect(table).toBeVisible();
    await page.getByRole("button", { name: "Review source evidence for AD-01" }).click(); await expect(page.getByRole("dialog", { name: "Asset evidence · AD-01" })).toBeVisible();
    fixture.state.allowed = false; await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Refresh reporting evidence", exact: true }).click();
    await expect(table).toHaveCount(0); await expect(page.getByRole("dialog", { name: /Asset evidence/ })).toHaveCount(0);
    fixture.state.allowed = true; await page.clock.install(); await page.goto("/overview"); await expect(page.getByTestId("metric-Net receipts")).toBeVisible();
    await page.clock.fastForward(600_002); await expect(page.getByRole("heading", { name: "Reporting access lease expired" })).toBeVisible();
    await expect(page.getByTestId("metric-Net receipts")).toHaveCount(0);
  } finally { await app.close(); }
});

test("paid asset source filters and signed cursor pages preserve membership without duplicates", async ({ page }) => {
  const { app } = configured(packet => {
    if (packet.viewKey !== "paidMedia") return;
    const feed = packet.facts.ads!.snapshot.feeds[0]!, original = feed.assets[0]!;
    feed.assets = Array.from({ length: 30 }, (_, index) => ({ ...original, assetRef: `fictional-asset-${index}`, label: `AD-${index + 100}` }));
  }); await listen(app);
  try {
    await login(page); await page.goto("/analytics/paid-media"); const table = page.getByRole("table", { name: "Top assets by click-through rate" });
    await expect(table.getByRole("row")).toHaveCount(26); const first = await table.locator("tbody th").allTextContents();
    await page.getByRole("button", { name: "Next asset page" }).click(); await expect(table.getByRole("row")).toHaveCount(8);
    expect((await table.locator("tbody th").allTextContents()).some(value => first.includes(value))).toBe(false);
    await page.getByRole("button", { name: "Rights: all", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Filter by rights state" });
    await dialog.getByRole("radio", { name: "not granted", exact: true }).check(); await dialog.getByRole("button", { name: /Apply|Done/ }).click();
    await expect(page).not.toHaveURL(/asset-cursor=/); await expect(table.getByRole("row")).toHaveCount(2);
    await expect(page.getByText(/Source selection: all · notGranted/)).toBeVisible(); await page.reload(); await expect(table.getByRole("row")).toHaveCount(2);
  } finally { await app.close(); }
});

test("a native cohort deep link reaches the source unchanged and cannot fall back to first-wave", async ({ page }) => {
  const { app } = configured(); await listen(app);
  try {
    await login(page); const denied = page.waitForResponse(response => response.url().endsWith("/v1/read") && response.request().postDataJSON().viewKey === "campaignFunnel");
    await page.goto("/campaigns/campaign-current?tab=funnel&cohort=unbound-cohort");
    const response = await denied; expect(response.request().postDataJSON().filters.cohort).toBe("unbound-cohort"); expect(response.status()).toBe(403);
    await expect(page.getByTestId("metric-contacts")).toHaveCount(0);
  } finally { await app.close(); }
});

test("all reporting families preserve complete responsive content and actual assistive speech", async ({ page }, info) => {
  test.setTimeout(240_000); const { app } = configured(); await listen(app);
  const routes = [["overview", "/overview", "Overview"], ["performance", "/analytics/attribution", "Every dollar, in perspective."], ["paid", "/analytics/paid-media", "See what earns the click."], ["launch", "/launch", "Your launch, in focus."], ["campaign", "/campaigns/campaign-current?tab=funnel", "Turn a plan into a checked cohort."], ["reconciliation", "/launch?view=reconciliation", "Do the pages agree?"]];
  try {
    await login(page);
    for (const [key, route, heading] of routes) {
      await page.goto(route!); await expect(page.getByRole("heading", { name: heading!, exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Source evidence", exact: true })).toBeVisible();
      for (const width of [1440, 1024, 390]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await accessible(page); await page.screenshot({ path: info.outputPath(`analytics-native-${key}-${width}.png`), fullPage: true }); }
      await page.setViewportSize({ width: 1440, height: 1000 });
      if (key === "overview") {
        const trigger = page.getByRole("button", { name: "Source evidence", exact: true }); await trigger.focus(); await page.keyboard.press("Enter"); const dialog = page.getByRole("dialog", { name: "Reporting source evidence" }); await expect(dialog).toBeVisible();
        await screenReaderCheckpoint(page, "analytics-source-table-headers", dialog.getByRole("region", { name: "Reporting source coverage" }), ["Reporting source coverage", "Owner", "Coverage", "Definition"], "KP_Enter");
        await page.keyboard.press("Escape"); await expect(trigger).toBeFocused(); await screenReaderCheckpoint(page, "analytics-source-focus-return", trigger, ["Source evidence", "button"]);
      }
      if (key === "performance") {
        const trigger = page.getByRole("button", { name: "Metric definitions", exact: true }); await trigger.focus(); await page.keyboard.press("Enter"); const dialog = page.getByRole("dialog", { name: "Metric definitions" });
        await expect(dialog.getByTestId("metric-dictionary")).toBeVisible(); await expect(dialog.getByTestId("static-definitions")).toBeVisible();
        for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`analytics-native-definitions-${width}.png`), fullPage: true }); }
        await page.setViewportSize({ width: 1440, height: 1000 }); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused(); await screenReaderCheckpoint(page, "analytics-definitions-focus-return", trigger, ["Metric definitions", "button"]);
      }
      if (key === "paid") await screenReaderCheckpoint(page, "analytics-paid-table-headers", page.getByRole("region", { name: "Paid channel metrics" }), ["Paid channel metrics", "Channel", "Media spend", "Platform ROAS"], "KP_Enter");
      if (key === "campaign") { await expect(page.getByTestId("metric-no-post")).toHaveText("Unknown"); await screenReaderCheckpoint(page, "analytics-campaign-table-headers", page.getByRole("region", { name: "Campaign progression" }), ["Campaign progression", "Campaign", "Contacted", "Posted"], "KP_Enter"); }
    }
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  } finally { await app.close(); }
});
