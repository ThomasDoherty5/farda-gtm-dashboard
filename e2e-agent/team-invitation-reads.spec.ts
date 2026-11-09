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

/** A legacy read source cannot grant the separate recruitment workspace's named actor authority. */
async function openUnboundComposer(page: Page) {
  const response = page.waitForResponse(value => value.url().endsWith("/v1/read") && value.request().method() === "POST" &&
    value.request().postDataJSON()?.viewKey === "invitationDraft" && value.request().postDataJSON()?.filters?.context === "recruitment");
  await page.goto("/creators/tiktok/invitations/new");
  const denied = await response;
  expect(denied.request().postDataJSON().filters).toEqual({ context: "recruitment" });
  expect(denied.status()).toBe(403);
  const body = await denied.json();
  expect(body).toMatchObject({ code: "RECRUITMENT_AUTHORITY_UNAVAILABLE", executionCertainty: "notApplied" });
  expect(body).not.toHaveProperty("data");
  await expect(page.getByRole("alert").filter({ hasText: "No access to this account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Make every term explicit." })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send request|Save invitation draft/ })).toHaveCount(0);
}

test("the invitation composer and team screen expose no demo draft or roles without their distinct authority and source bindings", async ({ page }) => {
  test.setTimeout(120_000);
  // The injected reader exists only to prove the other states below; this case uses a server with none.
  await app.close();
  app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN });
  await listen();
  await login(page);
  await openUnboundComposer(page);
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

test("the configured legacy draft stays read-only, cannot bind the native composer, and returns no data after source denial", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, true);
  const legacy = await sessionRead(page, "invitationDraft");
  expect(legacy.status()).toBe(200);
  const body = await legacy.json();
  expect(body).toMatchObject({ dataState: "ready", data: { datasetKey: "invitation-native", synthetic: true,
    provenance: { evidenceStage: "synthetic" }, draftVersion: "synthetic-draft-v1",
    quota: { state: "unknown", reasonCode: "QUOTA_NOT_READ" } },
    capabilities: [{ actionKind: "sendInvitation", state: "held", reasonCodes: ["INVITATION_ACTIONS_NOT_CONNECTED"] }] });
  await openUnboundComposer(page);
  await expect(page.getByText("@synthetic.creator", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Synthetic historical model", { exact: false })).toHaveCount(0);
  mode = "denied";
  const denied = await sessionRead(page, "invitationDraft");
  expect(denied.status()).toBe(403);
  const denial = await denied.json();
  expect(denial).toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", executionCertainty: "notApplied" });
  expect(denial).not.toHaveProperty("data");
  await openUnboundComposer(page);
  await expect(page.getByText("@synthetic.creator", { exact: false })).toHaveCount(0);
  await expect(page.getByText("TT-COMMERCE-v2", { exact: false })).toHaveCount(0);
  expect(app.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);
});
