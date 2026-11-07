import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { analyticsTestScope, ordersFixture, syntheticAnalyticsSources } from "../src/creator-agent/analytics/fixtures.testkit.ts";
import type { AnalyticsSourceRequest } from "../src/creator-agent/analytics/sources.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

/** THO-293: the Overview reads the actual local HTTP/SQLite agent service with fictional injected order and ad readers. */
const options = { databasePath: ":memory:", workspaceId: analyticsTestScope.workspaceId, accountId: analyticsTestScope.accountId,
  readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, analyticsTimezone: "America/Los_Angeles" };
async function listen(app: ReturnType<typeof createAgentServer>) {
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
}
async function login(page: Page) { expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).ok()).toBe(true); }

test("unconnected sources are a visible per-source state with N/A figures, never an error page, demo or zero figures", async ({ page }) => {
  const app = createAgentServer(options); await listen(app);
  try {
    await login(page); await page.goto("/overview");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.getByTestId("source-states")).toContainText("Orders: not connected · Ad platforms: not connected");
    await expect(page.getByText("Data unavailable")).toHaveCount(0);
    await expect(page.getByTestId("metric-Net receipts")).toContainText("N/A");
    await expect(page.getByTestId("metric-Paid orders")).toContainText("N/A");
    for (const demoFigure of ["$12,596", "Demo performance", "Illustrative figures"]) await expect(page.getByText(demoFigure, { exact: false })).toHaveCount(0);
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  } finally { await app.close(); }
});

test("the Overview renders served orders, keeps MER and monitor figures N/A with reasons, and shows a stale source", async ({ page }) => {
  let staleOrders = false;
  const sources = syntheticAnalyticsSources(() => Date.now());
  const app = createAgentServer({ ...options, analyticsSources: { ...sources, orders: async (request: AnalyticsSourceRequest) => {
    const snapshot = ordersFixture(request, Date.now());
    if (staleOrders) snapshot.feeds[0]!.lastSuccessAt = new Date(Date.now() - 20 * 60_000).toISOString();
    return snapshot;
  } } });
  await listen(app);
  try {
    await login(page); await page.goto("/overview");
    await expect(page.getByTestId("metric-Net receipts")).toHaveText("$12,596");
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
    await expect(page.getByText("$31.49 average net receipts")).toBeVisible();
    await expect(page.getByTestId("metric-Contribution")).toContainText("Landed costs are not connected.");
    await expect(page.getByTestId("metric-Marketing efficiency")).toHaveText("N/A · creator costs are not connected");
    await expect(page.getByTestId("metric-Blended CAC")).toHaveText("N/A · creator costs are not connected");
    // Creator-marked codes only: 180 discount-code orders include 20 sitewide-promotion orders.
    await expect(page.getByTestId("metric-Attributed orders")).toHaveText("160");
    await expect(page.getByTestId("source-states")).toHaveCount(0);
    await expect(page.getByTestId("metric-Views")).toContainText("Read on the content monitor page.");
    await expect(page.getByText("Demo performance")).toHaveCount(0);
    await expect(page.getByText("Source data is stale")).toHaveCount(0);
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => [Object.keys(window.localStorage), Object.keys(window.sessionStorage)])).toEqual([[], []]);

    staleOrders = true; await page.reload();
    await expect(page.getByText("Source data is stale")).toBeVisible();
    await expect(page.getByText("SOURCE_STALE", { exact: false })).toBeVisible();
    await expect(page.getByTestId("metric-Net receipts")).toHaveText("$12,596");
  } finally { await app.close(); }
});
