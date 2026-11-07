// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readResponseSchema } from "@/adapter/contract";
import { viewSchemas } from "@/adapter/viewSchemas";
import { adapterErrorBodySchema } from "@/adapter/wire";
import { createAgentServer, type AgentServerOptions } from "./server";
import { SOURCING_CLOCK_SKEW_MS, sourcingPlanSchema } from "./sourcing/contract";
import { sourcingSourceFixture, sourcingTestScope, sourcingTestTime } from "./sourcing/fixtures.testkit";
import { SourcingError, type SourcingSnapshot } from "./sourcing/source";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";

const apps: ReturnType<typeof createAgentServer>[] = [];
const dirs: string[] = [];
const requestedScope = { workspaceId: sourcingTestScope.workspaceId, accountIds: [sourcingTestScope.accountId], environment: "sandbox" };
type Auth = "reader" | "reviewer" | "none" | { cookie: string };
async function start(extra: Partial<AgentServerOptions> = {}, clock = { now: sourcingTestTime }) {
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: sourcingTestScope.workspaceId, accountId: sourcingTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => clock.now }, ...extra });
  apps.push(app);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test service");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = (auth: Auth): Record<string, string> => auth === "none" ? {} : typeof auth === "object" ? { cookie: auth.cookie }
    : { authorization: "Bearer " + (auth === "reviewer" ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN) };
  const call = async (path: string, body?: unknown, auth: Auth = "reader") => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers(auth), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const envelope = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-sourcing-plan-read",
    requestedScope, viewKey: "sourcingPlan", filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 }, ...overrides });
  const read = (overrides: Record<string, unknown> = {}, auth: Auth = "reader") => call("/v1/read", envelope(overrides), auth);
  return { app, call, read, base };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const planEnvelope = readResponseSchema(viewSchemas.sourcingPlan!);
/** D-14: every refusal is the server's shared error envelope, carrying the full canonical body and nothing else. */
function expectCanonicalError(body: Record<string, unknown>, code: string, status: number) {
  expect(adapterErrorBodySchema.strict().parse(body)).toMatchObject({ code, requestId: "synthetic-sourcing-plan-read", correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    retryable: status >= 500, retryAfterMs: null, executionCertainty: "notApplied" });
  expect(Object.keys(body).sort()).toEqual(["code", "correlationId", "executionCertainty", "message", "requestId", "retryAfterMs", "retryable", ...("fieldErrors" in body ? ["fieldErrors"] : [])].sort());
  expect(body).not.toHaveProperty("data");
}
const tracked = (snapshot: () => SourcingSnapshot | null) => {
  const counter = { reads: 0 };
  return { counter, source: async () => { counter.reads++; return structuredClone(snapshot()); } };
};

describe("daily sourcing plan reads over HTTP and SQLite", () => {
  it("answers an honest unconfigured state, and the capabilities say no source is connected", async () => {
    const { read, call } = await start();
    const result = await read();
    expect(result.status).toBe(200);
    const parsed = planEnvelope.parse(result.body);
    expect(parsed).toMatchObject({ dataState: "unavailable", coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: false, reasonCodes: ["SOURCING_SOURCE_UNCONFIGURED"] },
      sourceFreshness: [{ freshnessState: "neverSynced", lastSourceSuccessAt: null }], page: { nextCursor: null, hasMore: false } });
    expect(sourcingPlanSchema.parse(parsed.data)).toMatchObject({ sourceState: "unconfigured", plan: null, missingReason: "SOURCING_SOURCE_UNCONFIGURED" });
    expect(parsed.capabilities.every((c) => c.state !== "available")).toBe(true);
    expect((await call("/v1/capabilities")).body.dailySourcingPlan).toEqual({ sourceAuthority: "notConnected", views: "read-only-projections", discoveryExecution: "notConnected", dispatch: "notConnected" });
  });

  it("denies unauthenticated and out-of-scope reads with no data and without touching the source", async () => {
    const { counter, source } = tracked(() => sourcingSourceFixture());
    const { read } = await start({ sourcingPlanSource: source });
    const anonymous = await read({}, "none");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toHaveProperty("data");
    for (const scope of [{ ...requestedScope, workspaceId: "synthetic-foreign-workspace" }, { ...requestedScope, accountIds: ["synthetic-foreign-account"] },
      { ...requestedScope, accountIds: [sourcingTestScope.accountId, "synthetic-foreign-account"] }, { ...requestedScope, environment: "production" }]) {
      const denied = await read({ requestedScope: scope });
      expect(denied.status).toBe(403);
      expectCanonicalError(denied.body, "FORBIDDEN", 403);
      expect(denied.body.message).toBe("Access is not currently permitted.");
    }
    expect(counter.reads).toBe(0);
  });

  it("serves a happy path through a synthetic reader to reader and reviewer sessions, matching the client schema", async () => {
    const { source } = tracked(() => sourcingSourceFixture());
    const { read, call } = await start({ sourcingPlanSource: source });
    const reviewer = planEnvelope.parse((await read({}, "reviewer")).body);
    expect(reviewer.scope).toEqual({ ...requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" });
    expect(reviewer.dataVersion).toMatch(/^sp1-[a-f0-9]{64}$/);
    const data = sourcingPlanSchema.parse(reviewer.data);
    expect(data.plan!.schedule.effectiveState).toBe("active");
    expect(data.plan!.capacity.map((r) => [r.source, r.kind, r.unit, r.state])).toEqual([
      ["social-cat", "invitations", "invitations", "current"], ["tiktok-shop", "invitations", "invitations", "unknown"], ["shared", "sampleUnits", "units", "current"],
      ["shared", "authorizedCost", "minorUnits", "current"],
      ...(["social-cat", "tiktok-shop"] as const).flatMap((source) => [["collaborationSlots", "slots"], ["apiRequests", "requests"], ["browserActions", "actions"]]
        .map(([kind, unit]) => [source, kind, unit, "unknown"]))]);
    expect(reviewer.sourceFreshness[0]).toMatchObject({ freshnessState: "current", lastSourceSuccessAt: new Date(sourcingTestTime).toISOString(), staleReasonCode: null });
    expect(reviewer.capabilities).toContainEqual({ actionKind: "requestBatchApproval", state: "held", reasonCodes: ["APPROVAL_SERVICE_NOT_CONNECTED"] });

    const login = await call("/v1/session", undefined, "reader");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const viaCookie = planEnvelope.parse((await read({}, { cookie })).body);
    expect(viaCookie.data).toEqual({ ...reviewer.data, observedAt: viaCookie.data!.observedAt });
    expect(viaCookie.dataVersion).toBe(reviewer.dataVersion);
    expect(viaCookie.capabilities).toContainEqual({ actionKind: "requestBatchApproval", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] });
    const text = JSON.stringify(reviewer);
    for (const secret of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, "synthetic-social-cat-account", "synthetic-invite-receipt-1"]) expect(text).not.toContain(secret);
  });

  it("keeps stale, partial and unknown values labeled instead of zero", async () => {
    const clock = { now: sourcingTestTime };
    let snapshot = sourcingSourceFixture();
    const { read } = await start({ sourcingPlanSource: async () => structuredClone(snapshot) }, clock);
    const partial = planEnvelope.parse((await read()).body);
    expect(partial.dataState).toBe("partial");
    const plan = sourcingPlanSchema.parse(partial.data).plan!;
    expect(plan.steps[3]!.count).toEqual({ value: null, missingReason: "J20_REVIEW_INCOMPLETE" });
    expect(plan.capacity[1]).toMatchObject({ state: "unknown", dispatchBlocked: true, remaining: { value: null } });
    // 5 steps + 10 expected capacity rows + 7 identity counts + 12 run counts.
    expect(partial.coverage).toMatchObject({ expectedCount: 34, observedCount: 24, missingCount: 10, complete: false });

    // A new source version must also be a newer observation; an equal time under another version is a conflict.
    clock.now = sourcingTestTime + 1000;
    snapshot = { ...sourcingSourceFixture(sourcingTestScope, clock.now), version: "synthetic-plan-source-partial", coverage: "partial" };
    const sourcePartial = planEnvelope.parse((await read()).body);
    expect(sourcePartial).toMatchObject({ dataState: "partial", sourceFreshness: [{ freshnessState: "partial", staleReasonCode: "SOURCE_COVERAGE_PARTIAL" }] });
    expect(sourcingPlanSchema.parse(sourcePartial.data).plan!.schedule.effectiveState).toBe("draft");

    clock.now = sourcingTestTime + 2 * 3600_000;
    const stale = planEnvelope.parse((await read()).body);
    expect(stale).toMatchObject({ dataState: "stale", coverage: { complete: false }, sourceFreshness: [{ freshnessState: "error", staleReasonCode: "SOURCE_STALE" }] });
    expect(sourcingPlanSchema.parse(stale.data).plan!.capacity.every((r) => r.dispatchBlocked)).toBe(true);
  });

  it("rejects forged filters, cursors and envelope fields with canonical errors before the source is read", async () => {
    const { counter, source } = tracked(() => sourcingSourceFixture());
    const { read } = await start({ sourcingPlanSource: source });
    for (const filters of [{ fixture: "discovery-demo" }, { scenario: "ready" }, { workspaceId: "synthetic-foreign-workspace" }, { sourceAccount: "synthetic-other" }, null]) {
      const forged = await read({ filters });
      expect(forged.status).toBe(422);
      expectCanonicalError(forged.body, "VALIDATION_FAILED", 422);
      expect(Object.keys(forged.body.fieldErrors).every((key: string) => key.startsWith("filters"))).toBe(true);
    }
    for (const overrides of [{ period: { preset: "today" } }, { sort: [{ field: "x", direction: "asc" }] }, { injected: true }, { schemaVersion: "2020-01-01" }, { operation: "submitAction" }]) {
      const refused = await read(overrides);
      expect(refused.status).toBe(422);
      expectCanonicalError(refused.body, "VALIDATION_FAILED", 422);
    }
    const cursor = await read({ page: { cursor: "sc1.synthetic", limit: 50 } });
    expect(cursor.status).toBe(422);
    expectCanonicalError(cursor.body, "INVALID_CURSOR", 422);
    expect(counter.reads).toBe(0);
  });

  it("fails closed on a malformed or denied source, and never answers an empty plan", async () => {
    let mode: "malformed" | "impossible-date" | "denied" | "foreign" | "valid-date" = "malformed";
    const { read } = await start({ sourcingPlanSource: async () => {
      if (mode === "denied") throw new SourcingError("UPSTREAM_DENIED", 403);
      if (mode === "foreign") return sourcingSourceFixture({ ...sourcingTestScope, workspaceId: "synthetic-foreign-workspace" });
      const s = sourcingSourceFixture() as unknown as Record<string, unknown>;
      if (mode === "malformed") return { ...s, capacity: "unknown" };
      // Only the reset date differs between these two: a real date is served, an impossible one is refused.
      const snapshot = sourcingSourceFixture();
      snapshot.capacity[0]!.resetAt = mode === "valid-date" ? "2026-11-30T00:00:00Z" : "2026-11-31T00:00:00Z";
      return snapshot;
    } });
    mode = "valid-date";
    expect((await read()).status).toBe(200);
    for (const [next, status, code] of [["malformed", 502, "SOURCE_RESPONSE_INVALID"], ["impossible-date", 502, "SOURCE_RESPONSE_INVALID"],
      ["denied", 403, "SOURCE_AUTHORITY_DENIED"], ["foreign", 403, "SOURCE_SCOPE_DENIED"]] as const) {
      mode = next;
      const result = await read();
      expect(result.status).toBe(status);
      expectCanonicalError(result.body, code, status);
    }
  });

  it("refuses source prose that could carry a handle or address, and never forwards it", async () => {
    let snapshot: unknown = sourcingSourceFixture();
    const { read } = await start({ sourcingPlanSource: async () => structuredClone(snapshot) });
    const personal = ["DM @synthetic.creator now", "synthetic.person@example.test", "https://example.test/synthetic-profile"];
    for (const text of personal) {
      const s = sourcingSourceFixture() as unknown as { steps: { nextAction: unknown; count: { value: unknown; missingReason: unknown } }[] };
      s.steps[0]!.nextAction = text;
      snapshot = s;
      const refused = await read();
      expect(refused.status).toBe(502);
      expectCanonicalError(refused.body, "SOURCE_RESPONSE_INVALID", 502);
      expect(JSON.stringify(refused.body)).not.toContain(text);
      s.steps[0]!.nextAction = "RESOLVE_IDENTITIES"; s.steps[3]!.count.missingReason = text;
      const again = await read();
      expect(again.status).toBe(502);
      expect(JSON.stringify(again.body)).not.toContain(text);
    }
  });

  it("applies the clock-skew tolerance and the maximum age over HTTP", async () => {
    const clock = { now: sourcingTestTime };
    let snapshot = sourcingSourceFixture(sourcingTestScope, sourcingTestTime + SOURCING_CLOCK_SKEW_MS);
    snapshot.validUntil = new Date(sourcingTestTime + 365 * 86_400_000).toISOString();
    const { read } = await start({ sourcingPlanSource: async () => structuredClone(snapshot) }, clock);
    const ahead = planEnvelope.parse((await read()).body);
    expect(sourcingPlanSchema.parse(ahead.data).sourceState).toBe("current");
    clock.now = sourcingTestTime + 300 * 86_400_000;
    const aged = planEnvelope.parse((await read()).body);
    expect(aged).toMatchObject({ dataState: "stale", sourceFreshness: [{ freshnessState: "error", staleReasonCode: "SOURCE_MAX_AGE_EXCEEDED" }] });
    snapshot = { ...sourcingSourceFixture(sourcingTestScope, clock.now + SOURCING_CLOCK_SKEW_MS + 1), version: "synthetic-plan-source-future" };
    const future = await read();
    expect(future.status).toBe(502);
    expectCanonicalError(future.body, "SOURCE_RESPONSE_INVALID", 502);
  });

  it("persists the source head in SQLite so a regressed snapshot is refused after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "farda-sourcing-")); dirs.push(dir);
    const databasePath = join(dir, "agent.sqlite");
    const newer = { ...sourcingSourceFixture(sourcingTestScope, sourcingTestTime + 60_000), version: "synthetic-plan-source-v2" };
    const first = await start({ databasePath, sourcingPlanSource: async () => structuredClone(newer) }, { now: sourcingTestTime + 120_000 });
    expect((await first.read()).status).toBe(200);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = await start({ databasePath, sourcingPlanSource: async () => sourcingSourceFixture() }, { now: sourcingTestTime + 120_000 });
    const regressed = await second.read();
    expect(regressed.status).toBe(409);
    expectCanonicalError(regressed.body, "SOURCE_VERSION_CHANGED", 409);
  });

  it("goes through the shared per-principal read admission, refusing over the limit with the shared envelope and no source read", async () => {
    const { counter, source } = tracked(() => sourcingSourceFixture());
    const { read } = await start({ sourcingPlanSource: source });
    for (let i = 0; i < 120; i++) expect((await read()).status).toBe(200);
    const limited = await read();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(adapterErrorBodySchema.strict().parse(limited.body)).toMatchObject({ code: "RATE_LIMITED", requestId: null, retryable: true,
      retryAfterMs: expect.any(Number), executionCertainty: "notApplied" });
    // Admission refuses before the body is read, so neither the request id nor the source is touched.
    expect(limited.body).not.toHaveProperty("data");
    expect(counter.reads).toBe(120);
    // Admission is per principal: the reviewer is still admitted.
    expect((await read({}, "reviewer")).status).toBe(200);
  });

  it("judges the lease over HTTP at response time, after the source read has completed", async () => {
    // The clock advances 1ms per read once the source has answered; the lease ends exactly when the response is projected.
    const clock = { now: sourcingTestTime, ticking: false };
    const snapshot = sourcingSourceFixture();
    snapshot.validUntil = new Date(sourcingTestTime + 2).toISOString();
    const { read } = await start({ operations: { now: () => clock.ticking ? ++clock.now : clock.now },
      sourcingPlanSource: async () => { clock.ticking = true; return structuredClone(snapshot); } });
    const result = planEnvelope.parse((await read()).body);
    expect(result).toMatchObject({ dataState: "stale", coverage: { complete: false }, sourceFreshness: [{ freshnessState: "error", staleReasonCode: "SOURCE_STALE" }] });
    expect(sourcingPlanSchema.parse(result.data)).toMatchObject({ sourceState: "expired", freshness: "stale", plan: { schedule: { effectiveState: "draft" } } });
  });

  it("leaves every other read view on the shared read union", async () => {
    const { read } = await start();
    expect((await read({ viewKey: "discoverySummary" })).body.data.kind).toBe("agent-sourcing");
    expect((await read({ viewKey: "sourcingPlanX" })).status).toBe(400);
  });
});
