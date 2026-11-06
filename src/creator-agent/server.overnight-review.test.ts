// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import type { ExpectedBinding } from "./connections/schema.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";

// Independent integration review: exercise the actual HTTP boundary rather than the reader's helpers.
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
describe("overnight operations independent HTTP review", () => {
  let app: ReturnType<typeof createAgentServer>;
  let origin: string;
  let now: number;
  beforeEach(async () => {
    now = Date.parse("2026-11-06T07:00:00Z");
    app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN,
      reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => now } });
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test address");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await app.close(); });
  const register = (action: string) => {
    const binding: ExpectedBinding = { ...scope, provider: "notion", providerAccountId: "synthetic-review-private-account", action,
      mode: "observe", route: "api", routeRef: "route:synthetic-review", requiredScopes: ["read"],
      authorizationScopeVersion: "synthetic-v1", toolVersion: "synthetic-v1", secretRef: "secretref:synthetic-review-private", connectionRef: "connection:synthetic-review-private" };
    return app.operations.ledger.register({ binding, ownerRef: "owner:synthetic-review-private", costBasis: { state: "unknown", reasonCode: "NOT_MEASURED" } }, 0);
  };
  async function read(viewKey: string, cursor: string | null = null, limit = 1, token: string | null = SYNTHETIC_READ_TOKEN, filters = {}) {
    const response = await fetch(`${origin}/v1/read`, { method: "POST", headers: { "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ schemaVersion: SCHEMA_VERSION,
      operation: "readView", requestId: "synthetic-independent-review", requestedScope: SYNTHETIC_SCOPE,
      viewKey, filters, period: null, sort: [], page: { cursor, limit } }) });
    return { status: response.status, body: await response.json() };
  }
  it("continues all saved binding pages through HTTP without exposing private source references", async () => {
    for (const action of ["readPolicy", "readOrders", "readMetrics"]) register(action);
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 3; index++) {
      const response = await read("connectionsOverview", cursor);
      expect(response.status).toBe(200);
      expect(response.body.data.coverage.total).toBe(3);
      expect(response.body.data.records).toHaveLength(1);
      ids.push(response.body.data.records[0].id);
      expect(JSON.stringify(response.body)).not.toContain("synthetic-review-private");
      expect(response.body.page.hasMore).toBe(index < 2);
      cursor = response.body.page.nextCursor;
      expect(cursor === null).toBe(index === 2);
    }
    expect(new Set(ids).size).toBe(3);
  });
  it("binds continuation to the view, page limit, current authorization and expiry", async () => {
    register("readPolicy"); register("readMetrics");
    const first = await read("connectionsOverview");
    expect(first.status).toBe(200);
    const cursor = first.body.page.nextCursor as string;
    expect(typeof cursor).toBe("string");
    expect((await read("channelCapabilities", cursor)).status).toBe(400);
    expect((await read("connectionsOverview", cursor, 2)).status).toBe(400);
    expect((await read("connectionsOverview", cursor, 1, null)).status).toBe(401);
    expect((await read("connectionsOverview", cursor, 1, SYNTHETIC_REVIEW_TOKEN)).status).toBe(400);
    const last = cursor.at(-1)!;
    expect((await read("connectionsOverview", cursor.slice(0, -1) + (last === "A" ? "B" : "A"))).status).toBe(400);
    now += 16 * 60_000;
    expect((await read("connectionsOverview", cursor)).status).toBe(409);
  });
  it("does not let a holder of the reader credential decrypt or forge operations continuation", async () => {
    register("readPolicy"); register("readMetrics");
    const first = await read("connectionsOverview");
    expect(first.status).toBe(200);
    expect(() => openOperationsToken(scope, SYNTHETIC_READ_TOKEN, "cursor", first.body.page.nextCursor)).toThrow();
    const forged = sealOperationsToken(scope, SYNTHETIC_READ_TOKEN, "cursor", { view: "connectionsOverview",
      authorization: "creator-agent.scope.v1:reader", filters: {}, limit: 1, offset: 1, expires: now + 60_000,
      marks: { bindings: 2, jobs: 0, runs: 0 } });
    expect(await read("connectionsOverview", forged)).toMatchObject({ status: 400, body: { code: "INVALID_OPERATIONS_CURSOR" } });
  });
  it("pages saved job definitions even when there are no run records", async () => {
    for (let index = 0; index < 3; index++) app.operations.jobs.register({ jobId: `synthetic-review-private-job-${index}`, version: 1,
      ownerRef: "owner:synthetic-review-private", mode: "observe", handler: "record-reference.v1", eventType: "synthetic-review",
      inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1", policyVersion: POLICY_VERSION,
      modelVersion: null, offerVersion: null, capabilityBinding: null,
      budgets: { maxItems: 1, maxSteps: 1, maxAttempts: 1, maxRunMs: 1000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 } }, 0);
    let cursor: string | null = null;
    const ids = new Set<string>();
    for (let index = 0; index < 3; index++) {
      const response = await read("automationRuns", cursor);
      expect(response.status).toBe(200);
      expect(response.body.data.records).toEqual([]);
      expect(response.body.data.jobs).toHaveLength(1);
      expect(response.body.data.jobs[0].enabled).toBe(false);
      expect(response.body.data.jobCoverage).toEqual({ total: 3, returned: index + 1, partial: index < 2 });
      expect(JSON.stringify(response.body)).not.toContain("synthetic-review-private");
      ids.add(response.body.data.jobs[0].id);
      cursor = response.body.page.nextCursor;
      expect(response.body.page.hasMore).toBe(index < 2);
    }
    expect(ids.size).toBe(3);
  });
  it("saves schedule drafts only with current reviewer authority and preserves activation state", async () => {
    const definition = { jobId: "synthetic-review-private-schedule-job", version: 1, ownerRef: "owner:synthetic-review-private", mode: "observe",
      handler: "record-reference.v1", eventType: "synthetic-review", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1",
      policyVersion: POLICY_VERSION, modelVersion: null, offerVersion: null, capabilityBinding: null,
      budgets: { maxItems: 1, maxSteps: 1, maxAttempts: 1, maxRunMs: 1000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 } } as const;
    app.operations.jobs.register(definition, 0);
    const ref = (await read("automationRuns")).body.data.jobs[0].scheduleRef as string;
    const initial = await read("scheduleDetail", null, 1, SYNTHETIC_READ_TOKEN, { jobId: ref });
    expect(initial.status).toBe(200);
    expect(initial.body.data).toMatchObject({ kind: "saved-schedule-draft", draft: null, draftVersion: "j1-d0", scheduleState: "disabled" });
    expect(initial.body.capabilities).toContainEqual({ actionKind: "enableSchedule", state: "held", reasonCodes: ["SCHEDULE_ACTIVATION_NOT_CONNECTED"] });
    const draft = { cadence: "daily", localTime: "08:30", timezone: "America/Los_Angeles", activeCohortOverride: false };
    const envelope = { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestId: "synthetic-independent-save", requestedScope: SYNTHETIC_SCOPE,
      resourceKind: "configurationDraft", resourceRef: `schedule-${ref}`, expectedVersion: "j1-d0", payload: draft, idempotencyKey: "synthetic-review-save" };
    const save = async (patch = {}, token = SYNTHETIC_REVIEW_TOKEN) => {
      const response = await fetch(`${origin}/v1/save`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ...envelope, ...patch }) });
      return { status: response.status, body: await response.json() };
    };
    expect((await save({}, SYNTHETIC_READ_TOKEN)).status).toBe(403);
    const saved = await save();
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ resourceRef: envelope.resourceRef, resourceVersion: "j1-d1", record: draft, executionCertainty: "applied" });
    expect(await save()).toEqual(saved);
    expect((await save({ payload: { ...draft, localTime: "09:00" } })).status).toBe(409);
    const stale = await save({ idempotencyKey: "synthetic-review-stale", payload: { ...draft, localTime: "09:00" } });
    expect(stale).toMatchObject({ status: 409, body: { code: "STALE_VERSION", currentVersion: "j1-d1", executionCertainty: "notApplied" } });
    const invalid = await save({ expectedVersion: "j1-d1", idempotencyKey: "synthetic-review-invalid", payload: { ...draft, timezone: "Mars/Olympus" } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.fieldErrors.timezone).toBeTruthy();
    app.operations.jobs.register({ ...definition, version: 2 }, 1);
    const changedJob = await save({ expectedVersion: "j1-d1", idempotencyKey: "synthetic-review-stale-job" });
    expect(changedJob).toMatchObject({ status: 409, body: { currentVersion: "j2-d1" } });
    const reread = await read("scheduleDetail", null, 1, SYNTHETIC_READ_TOKEN, { jobId: ref });
    expect(reread.body.data).toMatchObject({ draft, jobVersion: 2, savedForJobVersion: 1, scheduleState: "disabled" });
    expect(app.operations.jobs.getJob(definition.jobId).enabled).toBe(false);
    expect(JSON.stringify(reread.body)).not.toContain("synthetic-review-private");
  });
});
