// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server";
import { lifecycleSourceFixture, lifecycleTestScope, lifecycleTestTime } from "./lifecycle/fixtures.testkit";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";

const apps: ReturnType<typeof createAgentServer>[] = [];
const requestedScope = { workspaceId: lifecycleTestScope.workspaceId, accountIds: [lifecycleTestScope.accountId], environment: "sandbox" };
async function start(extra: Partial<AgentServerOptions> = {}) {
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: lifecycleTestScope.workspaceId, accountId: lifecycleTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => lifecycleTestTime }, ...extra });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test service");
  const call = async (path: string, body?: unknown, reviewer = false) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + (reviewer ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const read = (viewKey: string, filters: unknown, reviewer = false, scope = requestedScope) => call("/v1/read", {
    schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-controls-lifecycle-read", requestedScope: scope,
    viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 },
  }, reviewer);
  return { app, call, read };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

function saveRequest(flow: string, data: ReturnType<typeof lifecycleSourceFixture>["flows"][number] & { draftVersion?: string }, version: string, key: string) {
  const event = data.entryEvents[0]!, timing = data.timingRules[0]!, template = data.templates[0]!;
  return { schemaVersion: "2026-11-02.proposed", operation: "saveResource", requestId: "synthetic-flow-save", requestedScope,
    resourceKind: "configurationDraft", resourceRef: "flow-" + flow, expectedVersion: version, idempotencyKey: key,
    payload: { entryEventRef: event.ref, timingRuleRef: timing.ref, timezone: timing.timezone,
      templateRef: template.ref, templateVersion: template.version, templateName: "Synthetic configured flow" } };
}

describe("authenticated controls and lifecycle integration", () => {
  it("exposes truthful source holds while preserving the existing native read surfaces", async () => {
    const { read, call } = await start();
    for (const [view, filters] of [["lifecycleOverview", {}], ["emailFlow", { flow: "setup" }],
      ["consentEligibility", {}], ["activationRetention", {}]] as const) {
      const result = await read(view, filters);
      expect(result.status).toBe(200);
      expect(result.body.data.sourceState).toBe("unconfigured");
      expect(result.body.coverage.complete).toBe(false);
    }
    const controls = await read("operationsControl", { section: "team" });
    expect(controls.status).toBe(200);
    expect(controls.body.data).toMatchObject({ kind: "native-operations-controls", sourceState: "notConnected", role: "reader" });
    expect((await read("watchlist", {})).status).toBe(200);
    const caps = (await call("/v1/capabilities")).body;
    expect(caps.lifecycleConfiguration).toMatchObject({ sourceAuthority: "notConnected", deliveryExecution: "notConnected" });
    expect(caps.operationsControls).toMatchObject({ sourceAuthority: "notConnected", taskExecution: "notConnected", repairExecution: "notConnected" });
  });

  it("rejects foreign scope and reader request-key lookups before source access", async () => {
    let reads = 0;
    const { read } = await start({ lifecycleSource: async () => { reads++; return lifecycleSourceFixture(); } });
    expect((await read("emailFlow", { flow: "early-access" }, false, { ...requestedScope, accountIds: ["foreign-account"] })).status).toBe(400);
    expect((await read("emailFlow", { flow: "early-access", draftRequestKey: "private-key" })).status).toBe(403);
    expect((await read("operationsControl", { section: "runs", proposalRequestKey: "private-key" })).status).toBe(403);
    expect(reads).toBe(0);
  });

  it("persists each allowlisted flow once and returns the exact immutable request receipt without changing the source", async () => {
    const source = lifecycleSourceFixture(), original = structuredClone(source);
    const { read, call } = await start({ lifecycleSource: async () => source });
    for (const flow of ["early-access", "abandoned-checkout", "review-request"]) {
      const before = await read("emailFlow", { flow }, true);
      expect(before.status).toBe(200);
      const request = saveRequest(flow, before.body.data.sourceConfig, before.body.data.draftVersion, "save-" + flow);
      expect((await call("/v1/save", request)).status).toBe(403);
      const one = await call("/v1/save", request, true), two = await call("/v1/save", request, true);
      expect(one.status).toBe(200);
      expect(two.body).toEqual(one.body);
      expect(one.body.record).toMatchObject({ requestKey: request.idempotencyKey, expectedVersion: request.expectedVersion,
        persistedByRef: "agent-reviewer", record: { flow, revision: 1, lockedPolicies: {
          recheckConsentBeforeSend: true, stopOnOptOutOrSuppression: true, preventDuplicateEnrollment: true } } });
      const after = await read("emailFlow", { flow, draftRequestKey: request.idempotencyKey }, true);
      expect(after.body.data.history.total).toBe(1);
      expect(after.body.data.requestedSave).toMatchObject({ state: "applied", disposition: "recorded", receipt: one.body.record });
    }
    expect(source).toEqual(original);
  });

  it("rejects forged activation/gates and unsupported resources without routing a flow draft into schedules", async () => {
    const { read, call } = await start({ lifecycleSource: async () => lifecycleSourceFixture() });
    const before = await read("emailFlow", { flow: "early-access" }, true);
    const request = saveRequest("early-access", before.body.data.sourceConfig, before.body.data.draftVersion, "forged-flow");
    for (const extra of [{ enabled: true }, { recheckConsentBeforeSend: false }, { recipient: "synthetic-recipient" }]) {
      const result = await call("/v1/save", { ...request, payload: { ...request.payload, ...extra } }, true);
      expect(result.status).toBe(422);
      expect(result.body.executionCertainty).toBe("notApplied");
    }
    expect((await call("/v1/save", { ...request, resourceRef: "flow-setup" }, true)).status).toBe(404);
    expect((await call("/v1/save", { ...request, resourceRef: "schedule-not-a-bound-job" }, true)).status).toBe(404);
    const after = await read("emailFlow", { flow: "early-access" }, true);
    expect(after.body.data.draft).toBeNull();
    expect(after.body.data.history.total).toBe(0);
  });
});
