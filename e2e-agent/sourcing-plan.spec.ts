import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer, type AgentServerOptions } from "../src/creator-agent/server.ts";
import { sourcingSourceFixture, sourcingTestScope } from "../src/creator-agent/sourcing/fixtures.testkit.ts";
import type { SourcingSnapshot } from "../src/creator-agent/sourcing/source.ts";
import { nativeSourcingSourceFixture } from "../src/creator-agent/sourcing/nativeFixtures.testkit.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

async function listen(app: ReturnType<typeof createAgentServer>) {
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
}
async function login(page: Page) { expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).ok()).toBe(true); }
async function accessible(page: Page) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test("the daily plan detail reads the served sourcing plan over actual HTTP and SQLite, and states every source condition honestly", async ({ page }, info) => {
  test.setTimeout(180_000);
  const directory = mkdtempSync(join(tmpdir(), "farda-sourcing-browser-"));
  const options: AgentServerOptions = { databasePath: join(directory, "agent.sqlite"), workspaceId: sourcingTestScope.workspaceId, accountId: sourcingTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN };
  let snapshot: SourcingSnapshot = sourcingSourceFixture(sourcingTestScope, Date.now() - 1000);
  const fixture = nativeSourcingSourceFixture({ now: Date.now });
  fixture.state.mutate = packet => { packet.snapshot = structuredClone(snapshot); packet.snapshot.version = fixture.state.version; packet.validUntil = new Date(Date.now() + 600_000).toISOString(); };
  let app = createAgentServer({ ...options, sourcingPlanSource: fixture.source });
  await listen(app);
  try {
    await login(page);
    await page.goto("/creators/discovery");
    await page.getByRole("link", { name: "Open daily plan detail" }).click();
    await expect(page).toHaveURL(/\/creators\/discovery\?view=plan$/);
    await expect(page.getByTestId("live-plan-schedule")).toContainText("Active");
    const capacity = page.getByRole("table", { name: "Source capacity in native units" });
    await expect(capacity.getByRole("row", { name: /^TikTok Shop · Invitations/ })).toContainText("Unknown · source limit not published");
    await expect(capacity.getByRole("row", { name: /^TikTok Shop · Invitations/ })).toContainText("Blocked · CAPACITY_UNKNOWN");
    await expect(capacity.getByRole("row", { name: /^Social Cat · Invitations/ })).toContainText("30 invitations");
    await expect(page.getByRole("table", { name: "Daily plan steps" }).getByRole("row", { name: /^Qualification/ })).toContainText("Unknown · direct video review incomplete");
    await expect(page.getByTestId("view-partial")).toBeVisible();
    const text = await page.locator("main").innerText();
    for (const raw of ["synthetic-social-cat-account", "synthetic-invite-receipt-1", "synthetic-daily-plan"]) expect(text).not.toContain(raw);
    await expect(page.getByRole("button", { name: /Request approval for a batch/ })).toHaveAttribute("aria-disabled", "true");
    // This session is a reader: the reason names the role and does not imply a reviewer could request approval today.
    await expect(page.getByText("Requires the reviewer role. Batch approval is also not connected yet, so no role can request it here today.")).toBeVisible();
    await accessible(page);
    await expect(page.getByText(/Synthetic owner evidence · sandbox/)).toBeVisible();
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: info.outputPath(`native-sourcing-plan-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await screenReaderCheckpoint(page, "sourcing-native-capacity-table", page.getByRole("region", { name: "Source capacity in native units" }), ["Source capacity", "Remaining", "Dispatch"], "KP_Enter");

    // The source claims active, but a closed browser session keeps the schedule a draft.
    snapshot = { ...sourcingSourceFixture(sourcingTestScope, Date.now() - 500), version: "synthetic-plan-source-v2" };
    snapshot.sources[1]!.session = "closed"; fixture.state.version = "fictional-plan-v2";
    await page.reload();
    await expect(page.getByTestId("live-plan-schedule")).toContainText("Draft · not active · source claims active");
    await expect(page.getByTestId("live-plan-schedule-holds")).toContainText("BROWSER_SESSION_CLOSED:tiktok-shop");

    // A source-owned current principal denial removes protected plan evidence.
    fixture.state.allowed = false;
    await page.getByRole("button", { name: "Refresh sourcing evidence", exact: true }).click();
    await expect(page.getByText("No access to this account")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByTestId("live-plan-versions")).toHaveCount(0);
  } finally { await app.close(); }

  // With no source configured, the same route says so: no demo plan and no zeros.
  app = createAgentServer(options);
  await listen(app);
  try {
    await login(page);
    await page.goto("/creators/discovery?view=plan");
    await expect(page.getByText("Daily sourcing source not connected")).toBeVisible();
    await expect(page.getByText(/Schedules, capacity and run counts remain Unknown/)).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await accessible(page);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
