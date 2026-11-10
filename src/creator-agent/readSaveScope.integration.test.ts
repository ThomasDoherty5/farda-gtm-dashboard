// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { viewSchemas } from "../adapter/viewSchemas/index.ts";
import { createAgentServer } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";

const apps: ReturnType<typeof createAgentServer>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.restoreAllMocks(); });
const scope = SYNTHETIC_SCOPE;
const readEnvelope = (viewKey = "overviewSummary", requestedScope: unknown = scope) => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "fictional-scope-read",
  requestedScope, viewKey, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 },
});
const saveVariants = [
  { resourceKind: "actionDraft", resourceRef: "fictional-offer", payload: {} },
  { resourceKind: "configurationDraft", resourceRef: "fictional-invitation", payload: { kind: "recruitmentInvitation" } },
  { resourceKind: "configurationDraft", resourceRef: "flow-early-access", payload: {} },
  { resourceKind: "configurationDraft", resourceRef: "schedule-fictional", payload: {} },
  { resourceKind: "evidenceDraft", resourceRef: "fictional-post", payload: { kind: "observation" } },
  { resourceKind: "reviewerAssessment", resourceRef: "fictional-post", payload: { kind: "override" } },
] as const;
const saveEnvelope = (variant: typeof saveVariants[number], requestedScope: unknown = scope) => ({
  schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestId: "fictional-scope-save", requestedScope,
  expectedVersion: null, idempotencyKey: `fictional-scope-${variant.resourceRef}-${variant.resourceKind}`, ...variant,
});

async function start() {
  const calls: string[] = [];
  // These are negative admission probes, never positive source/grant fixtures.
  // No owner, including its final fence, may run for a foreign request scope.
  const forbiddenRead = (owner: string) => async () => { calls.push(owner); throw new Error("Source invoked before scope denial"); };
  const owner = (name: string) => ({ read: forbiddenRead(name), assertCurrent() { calls.push(`${name}.fence`); throw new Error("Fence invoked before scope denial"); } });
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: scope.workspaceId, accountId: scope.accountIds[0]!,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    analyticsSource: owner("analytics"), sourcingPlanSource: owner("sourcing"), shippingHubSource: owner("shipping"),
    financeSource: owner("finance"), operationsReadSource: owner("operations"), teamInvitationReadSource: owner("team"),
    lifecycleSource: owner("lifecycle"), monitorSource: owner("monitor"), collaborationSourceReader: owner("collaboration"),
    operationsControlSource: owner("controls"), recruitmentSource: owner("recruitmentQueue"), recruitmentWorkspace: { source: owner("recruitmentWorkspace") },
    stockSupportSource: { ...owner("stockSupport"), readInventory: forbiddenRead("inventory"), readSupport: forbiddenRead("support") },
    siteTraffic: { source: { ...owner("traffic"), readCapability: forbiddenRead("trafficCapability"), readReport: forbiddenRead("trafficReport") },
      orders: { ...owner("matchingOrders"), readAggregate: forbiddenRead("matchingOrders") },
      clicks: { ...owner("creatorClicks"), readAggregate: forbiddenRead("creatorClicks") } },
  });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected local HTTP service");
  const post = async (path: "/v1/read" | "/v1/save", body: unknown, token: string | null = path === "/v1/save" ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const savedRows = () => ["offer_commands", "recruitment_invitation_saves", "lifecycle_draft_requests", "schedule_draft_receipts", "evidence_review_requests"]
    .map(table => Number(app.store.database.prepare(`SELECT count(*) n FROM ${table}`).get()!.n));
  return { app, post, calls, savedRows };
}
function denied(result: { status: number; body: Record<string, unknown> }, status = 403, code = "FORBIDDEN") {
  expect(result.status).toBe(status);
  expect(Object.keys(result.body).sort()).toEqual(["code", "correlationId", "executionCertainty", "message", "requestId", "retryAfterMs", "retryable"]);
  expect(result.body).toMatchObject({ code, executionCertainty: "notApplied" });
  expect(result.body).not.toHaveProperty("data"); expect(result.body).not.toHaveProperty("record");
  for (const secret of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, "Source invoked before scope denial"])
    expect(JSON.stringify(result.body)).not.toContain(secret);
}

describe("shared read/save granted-scope boundary over actual HTTP", () => {
  it("denies all 65 registered read keys and all six save variants before source or durable save owners", async () => {
    const f = await start(), before = f.savedRows(), canonicalRead = vi.spyOn(f.app.store, "latest");
    const foreign = { ...scope, accountIds: ["fictional-foreign-account"] };
    expect(Object.keys(viewSchemas)).toHaveLength(65);
    // 65 reads / 6 writes stay inside the unchanged 120 / 30 admission limits.
    for (const key of Object.keys(viewSchemas)) denied(await f.post("/v1/read", readEnvelope(key, foreign)));
    for (const variant of saveVariants) denied(await f.post("/v1/save", saveEnvelope(variant, foreign)));
    expect(f.calls).toEqual([]); expect(canonicalRead).not.toHaveBeenCalled(); expect(f.savedRows()).toEqual(before);
  });

  it("distinguishes valid foreign scopes from malformed scopes and envelopes without granting an owner", async () => {
    const f = await start(), before = f.savedRows();
    const foreignScopes = [
      { ...scope, workspaceId: "fictional-foreign-workspace" }, { ...scope, accountIds: ["fictional-foreign-account"] },
      { ...scope, environment: "demo" }, { ...scope, environment: "production" }, { ...scope, accountIds: [] },
      { ...scope, accountIds: [...scope.accountIds, "fictional-foreign-account"] }, { ...scope, accountIds: [...scope.accountIds, ...scope.accountIds] },
    ];
    for (const selected of foreignScopes) {
      denied(await f.post("/v1/read", readEnvelope("overviewSummary", selected)));
      denied(await f.post("/v1/save", saveEnvelope(saveVariants[0], selected)));
    }
    for (const malformed of [null, {}, { ...scope, workspaceId: "" }, { ...scope, accountIds: "account" },
      { ...scope, accountIds: [null] }, { ...scope, environment: "staging" }, { ...scope, role: "founder" }]) {
      denied(await f.post("/v1/read", readEnvelope("overviewSummary", malformed)), 400, "INVALID_INPUT");
      denied(await f.post("/v1/save", saveEnvelope(saveVariants[0], malformed)), 400, "INVALID_INPUT");
    }
    denied(await f.post("/v1/read", { ...readEnvelope(), page: { cursor: null, limit: -1 } }), 400, "INVALID_INPUT");
    denied(await f.post("/v1/save", { ...saveEnvelope(saveVariants[0]), resourceKind: "unsupported" }), 400, "INVALID_INPUT");
    expect((await f.post("/v1/read", readEnvelope("overviewSummary", foreignScopes[0]), null)).status).toBe(401);
    expect((await f.post("/v1/save", saveEnvelope(saveVariants[0], foreignScopes[0]), SYNTHETIC_READ_TOKEN)).status).toBe(403);
    expect(f.calls).toEqual([]); expect(f.savedRows()).toEqual(before);
  });
});
