// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readResponseSchema } from "../adapter/contract.ts";
import { analyticsViewSchemas } from "../adapter/viewSchemas/analytics.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { nativeAnalyticsFixture } from "./analytics/nativeFixtures.testkit.ts";
import { nativeAnalyticsViewKeys, type NativeAnalyticsViewKey } from "./analytics/contract.ts";
import { NativeAnalyticsError } from "./analytics/nativeSource.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";

const apps: ReturnType<typeof createAgentServer>[] = [], dirs: string[] = [];
const CANONICAL = ["code", "correlationId", "executionCertainty", "message", "requestId", "retryAfterMs", "retryable"];
async function start(configured = true) {
  const fixture = nativeAnalyticsFixture(), calls: string[] = [], original = fixture.source.read;
  fixture.source.read = async (binding, signal) => { calls.push(binding.request.viewKey); return original(binding, signal); };
  const dir = mkdtempSync(join(tmpdir(), "farda-native-analytics-")); dirs.push(dir);
  const options: AgentServerOptions = { databasePath: join(dir, "agent.sqlite"), workspaceId: fixture.scope.workspaceId, accountId: fixture.scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: fixture.now }, analyticsSource: configured ? fixture.source : undefined };
  const app = createAgentServer(options); apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected local test service");
  const requestedScope = { workspaceId: fixture.scope.workspaceId, accountIds: [fixture.scope.accountId], environment: "sandbox" };
  const envelope = (key: NativeAnalyticsViewKey, overrides: Record<string, unknown> = {}) => ({ schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-analytics-read", requestedScope, ...fixture.request(key), ...overrides });
  const post = async (body: unknown, token: string | null = SYNTHETIC_READ_TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/read`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { fixture, calls, options, app, requestedScope, envelope, post };
}
const canonical = (body: Record<string, unknown>, code: string) => {
  expect(Object.keys(body).sort()).toEqual(CANONICAL); expect(body).toMatchObject({ code, executionCertainty: "notApplied" });
  expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/); expect(typeof body.message).toBe("string"); expect(body).not.toHaveProperty("data");
};
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("all seven native analytics keys through actual authenticated HTTP and SQLite", () => {
  it("refuses unauthenticated/wrong-scope reads before touching any source", async () => {
    const f = await start();
    expect((await f.post(f.envelope("overviewSummary"), null)).status).toBe(401);
    expect((await f.post(f.envelope("overviewSummary"), "wrong-token")).status).toBe(401);
    for (const requestedScope of [{ ...f.requestedScope, workspaceId: "foreign" }, { ...f.requestedScope, accountIds: ["foreign"] }, { ...f.requestedScope, accountIds: [...f.requestedScope.accountIds, "foreign"] }, { ...f.requestedScope, environment: "production" }, { ...f.requestedScope, environment: "demo" }]) {
      for (const key of nativeAnalyticsViewKeys) { const result = await f.post(f.envelope(key, { requestedScope })); expect(result.status).toBe(403); canonical(result.body, "FORBIDDEN"); }
    }
    expect(f.calls).toEqual([]);
  });
  it("serves every registered key with strict native synthetic metadata to reader and reviewer", async () => {
    const f = await start();
    for (const key of nativeAnalyticsViewKeys) for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) {
      const result = await f.post(f.envelope(key), token);
      expect(result.status, `${key}: ${JSON.stringify(result.body)}`).toBe(200);
      const parsed = readResponseSchema(analyticsViewSchemas[key]!).safeParse(result.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
      expect(result.body).toMatchObject({ requestId: "synthetic-analytics-read", scope: { ...f.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, page: { nextCursor: null, hasMore: false }, data: { datasetKey: "analytics-native", viewKey: key, provenance: { evidenceStage: "synthetic", synthetic: true } } });
      expect(result.body.dataVersion).toMatch(key === "overviewSummary" ? /^overview-v1-[a-f0-9]{64}$/ : /^analytics-v1-[a-f0-9]{64}$/);
      expect(JSON.stringify(result.body.data)).not.toMatch(/fictional-|synthetic-shopify|cust-shopify|permissionVersion|principalRef/);
      expect(JSON.stringify(result.body)).not.toContain(SYNTHETIC_READ_TOKEN);
    }
    const first = (await f.post(f.envelope("overviewSummary"))).body;
    expect(first.data.orders.value).toBe(400); expect(first.data.netReceipts.value).toEqual({ minorUnits: 1259600, currency: "USD" });
    expect(first.data.measures.find((row: { metricId: string }) => row.metricId === "aov").result.value).toBe(3149);
    expect((await f.post(f.envelope("overviewSummary"))).body.dataVersion).toBe(first.dataVersion);
    const period = { startAt: "2026-10-25T00:00:00.000Z", endAt: "2026-11-01T00:00:00.000Z", timezone: "UTC", basis: "eventTime" };
    const week = await f.post(f.envelope("overviewSummary", { period })); expect(week.status).toBe(200); expect(week.body.data.daily).toHaveLength(7); expect(week.body.dataVersion).not.toBe(first.dataVersion);
  });
  it("returns typed unavailable for an unconfigured source and keeps readiness and195 on their own owners", async () => {
    const f = await start(false);
    for (const key of nativeAnalyticsViewKeys) { const result = await f.post(f.envelope(key)); expect(result.status).toBe(503); canonical(result.body, "ANALYTICS_SOURCE_UNCONFIGURED"); }
    expect((await f.post(f.envelope("overviewSummary", { viewKey: "launchControl", filters: {} }))).body.code).toBe("READINESS_SOURCE_UNCONFIGURED");
    const traffic = await f.post(f.envelope("overviewSummary", { viewKey: "customerJourney", filters: { period: null, segment: { kind: "all" } } }));
    expect(traffic.status).toBe(200); expect(traffic.body.data.datasetKey).toBe("site-traffic-native"); expect(traffic.body.data.capability.state).toBe("unconfigured");
    expect(f.calls).toEqual([]);
  });
  it("consumes shared per-principal admission without a source read after the limit", async () => {
    const f = await start();
    for (let index = 0; index < 120; index++) expect((await f.post(f.envelope("metricDictionary"))).status).toBe(200);
    const limited = await f.post(f.envelope("overviewSummary")); expect(limited.status).toBe(429); expect(limited.body).toMatchObject({ code: "RATE_LIMITED", requestId: null, retryable: true, executionCertainty: "notApplied" });
    expect(f.calls).toHaveLength(120); expect((await f.post(f.envelope("overviewSummary"), SYNTHETIC_REVIEW_TOKEN)).status).toBe(200);
  });
  it("keeps partial/stale and missing values distinct from known zero through the wire schema", async () => {
    const f = await start();
    f.fixture.state.mutate = snapshot => { if (snapshot.viewKey !== "overviewSummary") return; const owner = snapshot.owners.find(row => row.owner === "commerceOrders")!; owner.coverage = "partial"; for (const feed of snapshot.facts.orders!.snapshot.feeds) { feed.orders = []; feed.coverage = "partial"; } };
    const partial = await f.post(f.envelope("overviewSummary")); expect(partial.status).toBe(200); expect(partial.body).toMatchObject({ dataState: "partial", coverage: { complete: false }, data: { orders: { state: "unknown", value: null } } });
    f.fixture.state.mutate = snapshot => { if (snapshot.viewKey !== "overviewSummary") return; const owner = snapshot.owners.find(row => row.owner === "commerceOrders")!; owner.sourceAsOf = new Date(f.fixture.state.now - 16 * 60000).toISOString(); for (const feed of snapshot.facts.orders!.snapshot.feeds) { feed.orders = []; feed.lastSuccessAt = owner.sourceAsOf; } };
    const stale = await f.post(f.envelope("overviewSummary")); expect(stale.status).toBe(200); expect(stale.body).toMatchObject({ dataState: "stale", coverage: { complete: false }, data: { orders: { state: "unknown", value: null } } });
    expect(readResponseSchema(analyticsViewSchemas.overviewSummary!).safeParse(stale.body).success).toBe(true);
    f.fixture.state.mutate = snapshot => { if (snapshot.viewKey === "overviewSummary") for (const feed of snapshot.facts.orders!.snapshot.feeds) feed.orders = []; };
    expect((await f.post(f.envelope("overviewSummary"))).body.data.orders).toMatchObject({ state: "known", value: 0 });
  });
  it("rejects forged filters and envelope fields before any source call", async () => {
    const f = await start();
    const cases = [{ filters: { scenario: "happy" } }, { filters: { fixture: "FX-01" } }, { filters: { workspaceId: "other" } }, { viewKey: "paidMedia", filters: { platform: "google", rights: "all" } }, { period: { startAt: "2026-10-01", endAt: "2026-10-02", timezone: "UTC", basis: "observationTime" } }, { sort: [{ field: "orders", direction: "desc" }] }, { schemaVersion: "2020-01-01" }, { adapterOverride: "demo" }, { requestId: "" }];
    for (const overrides of cases) { const result = await f.post(f.envelope("overviewSummary", overrides)); expect(result.status).toBe(400); canonical(result.body, "INVALID_INPUT"); }
    expect(f.calls).toEqual([]);
  });
  it("fails malformed/source-scope/denial closed without private strings and retains unrelated routes", async () => {
    const f = await start();
    f.fixture.state.mutate = snapshot => { snapshot.owners[0]!.requestDigest = "a".repeat(64); };
    let result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(403); canonical(result.body, "ANALYTICS_BINDING_MISMATCH");
    f.fixture.state.mutate = snapshot => { snapshot.permissionVersion = ""; };
    result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(503); canonical(result.body, "ANALYTICS_SOURCE_INVALID");
    f.fixture.state.mutate = null; f.fixture.state.allowed = false;
    result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(403); canonical(result.body, "ANALYTICS_SOURCE_DENIED");
    f.fixture.state.allowed = true;
    expect((await f.post(f.envelope("overviewSummary", { viewKey: "discoverySummary" }))).status).toBe(200);
    expect((await f.post(f.envelope("overviewSummary", { viewKey: "noSuchView" }))).status).toBe(400);
  });
  it("rejects source revocation, version change and exact lease expiry during an awaited read", async () => {
    for (const mode of ["permission", "source", "lease"] as const) {
      const f = await start(); f.fixture.state.afterRead = () => { if (mode === "permission") f.fixture.state.allowed = false; else if (mode === "source") f.fixture.state.sourceVersion = "changed"; else f.fixture.state.now += 60000; };
      const result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(mode === "permission" ? 403 : 409); expect(result.body).not.toHaveProperty("data");
    }
  });
  it("judges data freshness after await while a separate current read grant remains valid", async () => {
    const f = await start();
    f.fixture.state.mutate = snapshot => {
      snapshot.validUntil = new Date(f.fixture.state.now + 10 * 60000).toISOString();
      for (const owner of snapshot.owners) owner.validUntil = snapshot.validUntil;
      if (snapshot.viewKey !== "overviewSummary") return;
      const owner = snapshot.owners.find(row => row.owner === "commerceOrders")!; owner.sourceAsOf = new Date(f.fixture.state.now - 14 * 60000).toISOString();
      for (const feed of snapshot.facts.orders!.snapshot.feeds) feed.lastSuccessAt = owner.sourceAsOf;
    };
    f.fixture.state.afterRead = () => { f.fixture.state.now += 2 * 60000; };
    const result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(200); expect(result.body.dataState).toBe("stale");
    expect(result.body.data.measures.find((row: { metricId: string }) => row.metricId === "aov").result.state).toBe("unknown");
  });
  it("rechecks the actual reader credential after captured-source await", async () => {
    const f = await start(); f.fixture.state.afterRead = () => { f.options.readToken = "synthetic-rotated-reader-token-00000000000000000"; };
    const result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(401); expect(result.body).not.toHaveProperty("data");
  });
  it("normalizes upstream exception metadata and refuses a broken service clock", async () => {
    const f = await start(); f.fixture.source.read = async () => { throw new NativeAnalyticsError("private-person@example.test", 403); };
    let result = await f.post(f.envelope("overviewSummary")); expect(result.status).toBe(503); canonical(result.body, "ANALYTICS_SOURCE_UNAVAILABLE"); expect(JSON.stringify(result.body)).not.toContain("private-person");
    const g = await start(); g.fixture.state.afterRead = () => { g.fixture.state.now = NaN; };
    result = await g.post(g.envelope("overviewSummary")); expect(result.status).toBe(500); canonical(result.body, "ANALYTICS_INVALID_CLOCK");
  });
});
