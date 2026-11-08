import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { FinanceError } from "../src/creator-agent/finance/source.ts";
import { financeTestSource, financeSnapshot } from "../src/creator-agent/finance/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";

const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
let app: ReturnType<typeof createAgentServer>;
let mode: "unconfigured" | "configured" | "denied" = "unconfigured";
const routes = ["/finance", "/finance/commissions", "/finance/settlements/COMM-DEMO-D", "/finance/payables/PAY-0012", "/finance/close/2026-10",
  "/finance/close/2026-10?view=months", "/finance/close/2026-10?view=manifest", "/analytics/finance"];

test.beforeEach(async () => {
  mode = "unconfigured";
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => Date.parse("2026-11-06T12:00:00.000Z") },
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
  await page.goto("/finance/payables/PAY-0012");
  await expect(page.getByRole("heading", { name: "Direct content fees end with proof." })).toBeVisible();
  await expect(page.getByText("@routine.with.ella", { exact: false }).first()).toBeVisible();
  mode = "denied";
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "No access to this account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Direct content fees end with proof." })).toHaveCount(0);
  await expect(page.getByText("@routine.with.ella", { exact: false })).toHaveCount(0);
});
