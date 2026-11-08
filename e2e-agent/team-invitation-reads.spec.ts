import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { TeamInvitationReadError } from "../src/creator-agent/teamInvitationReads/source.ts";
import { teamInvitationTestSource, teamInvitationSnapshot } from "../src/creator-agent/teamInvitationReads/fixtures.testkit.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";

const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
let app: ReturnType<typeof createAgentServer>;
let mode: "configured" | "denied" = "configured";
const listen = () => new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
/** Demo roles, owners and draft values that must never appear when the source is not connected. */
const demoValues = ["@studio.rae", "TT-COMMERCE-v2", "SAMPLE-DEMO-015", "15 planned", "Approve Pay step", "Needs assignment", "Express authorization missing"];

test.beforeEach(async () => {
  mode = "configured";
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => Date.parse("2026-11-06T12:00:00.000Z") },
    teamInvitationReadSource: teamInvitationTestSource(async (_scope, request) => {
      if (mode === "denied") throw new TeamInvitationReadError("DENIED", 403);
      return { ...teamInvitationSnapshot(request.viewKey), scope: { ...scope } };
    }) });
  await listen();
});
test.afterEach(async () => { await app.close(); });
async function login(page: Page, reviewer = false) {
  expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + (reviewer ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN) } })).ok()).toBe(true);
}
/** A read through the browser's own session cookie and the same proxy the screens use. */
const sessionRead = (page: Page, viewKey: string) => page.request.post("/v1/read", { data: { schemaVersion: SCHEMA_VERSION, operation: "readView",
  requestId: "synthetic-browser-read", requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" },
  viewKey, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 } } });

test("the invitation composer and team screen show no demo draft or roles when the source is not connected", async ({ page }) => {
  test.setTimeout(120_000);
  // The injected reader exists only to prove the other states below; this case uses a server with none.
  await app.close();
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN });
  await listen();
  await login(page);
  await page.goto("/creators/tiktok/invitations/new");
  await expect(page.getByRole("alert").filter({ hasText: "Data unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send request/ })).toHaveCount(0);
  for (const demo of demoValues) await expect(page.getByText(demo, { exact: false }), demo).toHaveCount(0);
  let axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  // The live team screen renders native operations controls; the teamPermissions read model behind the same session is pending, not demo roles.
  for (const viewKey of ["teamPermissions", "invitationDraft"]) {
    const pending = await sessionRead(page, viewKey);
    expect(pending.status(), viewKey).toBe(503);
    const body = await pending.json();
    expect(body, viewKey).toMatchObject({ code: "INTEGRATION_PENDING", executionCertainty: "notApplied",
      reasonCodes: [viewKey === "teamPermissions" ? "TEAM_PERMISSIONS_SOURCE_UNCONFIGURED" : "INVITATION_SOURCE_UNCONFIGURED"] });
    expect(body).not.toHaveProperty("data");
  }
  await page.goto("/settings/team");
  await expect(page.getByText("Source authority is not connected")).toBeVisible();
  for (const demo of demoValues) await expect(page.getByText(demo, { exact: false }), demo).toHaveCount(0);
  axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});

test("a configured source renders a validated draft whose send stays blocked, and a later source denial clears it", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/creators/tiktok/invitations/new");
  await expect(page.getByRole("heading", { name: "Make every term explicit." })).toBeVisible();
  await expect(page.getByTestId("metric-Live quota remaining")).toContainText("N/A");
  const send = page.getByRole("button", { name: /Send request/ });
  await expect(send).toBeVisible();
  await expect(send).toHaveAttribute("aria-disabled", "true");
  mode = "denied";
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "No access to this account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Make every term explicit." })).toHaveCount(0);
  await expect(page.getByText("TT-COMMERCE-v2", { exact: false })).toHaveCount(0);
});
