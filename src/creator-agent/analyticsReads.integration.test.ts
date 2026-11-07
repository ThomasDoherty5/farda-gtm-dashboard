// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readResponseSchema } from "../adapter/contract";
import { analyticsViewSchemas } from "../adapter/viewSchemas/analytics";
import { createAgentServer, type AgentServerOptions } from "./server";
import { analyticsTestScope, analyticsTestTime, analyticsTestTimezone, ordersFixture, syntheticAnalyticsSources } from "./analytics/fixtures.testkit";
import type { AnalyticsSourceRequest, AnalyticsSources } from "./analytics/sources";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";

const apps: ReturnType<typeof createAgentServer>[] = [];
const dirs: string[] = [];
const requestedScope = { workspaceId: analyticsTestScope.workspaceId, accountIds: [analyticsTestScope.accountId], environment: "sandbox" };
const CANONICAL = ["code", "correlationId", "executionCertainty", "message", "requestId", "retryAfterMs", "retryable"];
const served = ["overviewSummary", "attribution", "paidMedia", "customerJourney"] as const;

/** Actual HTTP service over a temporary SQLite file, with counted synthetic readers. */
async function start(extra: Partial<AgentServerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "farda-analytics-")); dirs.push(dir);
  const app = createAgentServer({ databasePath: join(dir, "agent.sqlite"), workspaceId: analyticsTestScope.workspaceId, accountId: analyticsTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => analyticsTestTime }, analyticsTimezone: analyticsTestTimezone, ...extra });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test service");
  const post = async (body: unknown, token: string | null = SYNTHETIC_READ_TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/read`, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const envelope = (viewKey: string, filters: unknown = {}, overrides: Record<string, unknown> = {}) => ({ schemaVersion: "2026-11-02.proposed", operation: "readView",
    requestId: "synthetic-analytics-read", requestedScope, viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, ...overrides });
  const capabilities = async () => (await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`, { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).json();
  return { post, envelope, capabilities };
}
function counted(sources: AnalyticsSources = syntheticAnalyticsSources()) {
  const calls: string[] = [];
  const wrapped = Object.fromEntries(Object.entries(sources).map(([key, read]) => [key, async (request: AnalyticsSourceRequest) => { calls.push(key); return read!(request); }]));
  return { calls, sources: wrapped as AnalyticsSources };
}
const expectCanonical = (body: Record<string, unknown>, code: string) => {
  expect(Object.keys(body).sort()).toEqual(CANONICAL);
  expect(body).toMatchObject({ code, correlationId: null, retryAfterMs: null, executionCertainty: "notApplied" });
  expect(typeof body.message).toBe("string");
  expect(body).not.toHaveProperty("data");
};
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("THO-293 analytics reads through the authenticated creator-agent service", () => {
  it("denies unauthenticated and wrong-scope reads before any source is read", async () => {
    const { calls, sources } = counted();
    const { post, envelope } = await start({ analyticsSources: sources });
    expect((await post(envelope("overviewSummary"), null)).status).toBe(401);
    expect((await post(envelope("overviewSummary"), "synthetic-wrong-token-000000000000000000")).status).toBe(401);
    for (const scope of [{ ...requestedScope, workspaceId: "foreign-workspace" }, { ...requestedScope, accountIds: ["foreign-account"] },
      { ...requestedScope, accountIds: [analyticsTestScope.accountId, "foreign-account"] }, { ...requestedScope, environment: "production" }, { ...requestedScope, environment: "demo" }]) {
      for (const view of [...served, "launchSnapshot"]) {
        const result = await post(envelope(view, {}, { requestedScope: scope }));
        expect(result.status).toBe(403);
        expectCanonical(result.body, "FORBIDDEN");
        expect(result.body.requestId).toBe("synthetic-analytics-read");
      }
    }
    expect(calls).toEqual([]);
  });

  it("returns 200 with each source's unconfigured, never-synced state and N/A figures when no reader is connected; pending views never fall back to demo data", async () => {
    const { post, envelope, capabilities } = await start();
    for (const view of served) {
      const result = await post(envelope(view, view === "paidMedia" ? { rights: "all", platform: "all" } : {}));
      expect(result.status).toBe(200);
      expect(readResponseSchema(analyticsViewSchemas[view]!).safeParse(result.body).success).toBe(true);
      expect(result.body.dataState).toBe("partial");
      expect(result.body.data.sources.every((x: { state: string; reasonCode: string }) => x.state === "unconfigured" && x.reasonCode === "SOURCE_UNCONFIGURED")).toBe(true);
      expect(result.body.sourceFreshness.every((f: { freshnessState: string; lastSourceSuccessAt: unknown }) => f.freshnessState === "neverSynced" && f.lastSourceSuccessAt === null)).toBe(true);
      expect(result.body.coverage).toMatchObject({ observedCount: 0, complete: false });
      expect(JSON.stringify(result.body.data)).not.toMatch(/"state":"known"/);
    }
    for (const view of ["launchSnapshot", "launchControl", "launchReconciliation", "campaignFunnel", "metricDictionary"]) {
      const result = await post(envelope(view, view === "campaignFunnel" ? { campaignId: "x", cohort: "first-wave" } : {}));
      expect(result.status).toBe(503);
      expectCanonical(result.body, "INTEGRATION_PENDING");
    }
    expect((await capabilities()).analyticsReads).toEqual({ orders: "notConnected", adPlatforms: "notConnected", sessions: "notConnected", support: "notConnected" });
  });

  it("serves every view in its contract schema from synthetic readers, to reader and reviewer alike", async () => {
    const { calls, sources } = counted();
    const { post, envelope, capabilities } = await start({ analyticsSources: sources });
    expect((await capabilities()).analyticsReads).toEqual({ orders: "injected", adPlatforms: "injected", sessions: "injected", support: "injected" });
    for (const view of served) for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) {
      const result = await post(envelope(view, view === "paidMedia" ? { rights: "all", platform: "all" } : {}), token);
      expect(result.status).toBe(200);
      const parsed = readResponseSchema(analyticsViewSchemas[view]!).safeParse(result.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
      expect(result.body).toMatchObject({ requestId: "synthetic-analytics-read", dataState: "ready", capabilities: [],
        scope: { ...requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, page: { nextCursor: null, hasMore: false } });
      expect(result.body.dataVersion).toMatch(/^an1-[a-f0-9]{64}$/);
      expect(result.body.sourceFreshness.every((f: { freshnessState: string }) => f.freshnessState === "current")).toBe(true);
      expect(JSON.stringify(result.body)).not.toMatch(/synthetic-(shopify|tiktok|meta)-|synthetic-(storefront|support)-|token/);
    }
    const overview = (await post(envelope("overviewSummary"))).body;
    expect(overview.data.orders.value).toBe(400);
    expect(overview.data.netReceipts.value).toEqual({ minorUnits: 1_259_600, currency: "USD" });
    expect(overview.data.measures.find((m: { key: string }) => m.key === "aov").value).toBe(3149);
    // The same answer twice has the same data version; a different window changes it.
    expect((await post(envelope("overviewSummary"))).body.dataVersion).toBe(overview.dataVersion);
    const week = await post(envelope("overviewSummary", { preset: "last7Days" }));
    expect(week.body.dataVersion).not.toBe(overview.dataVersion);
    expect(week.body.data.daily).toHaveLength(7);
    expect(calls).toContain("sessions");
  });

  it("reports stale, partial and unknown sources with server-computed freshness instead of zero", async () => {
    const base = syntheticAnalyticsSources();
    let mode: "stale" | "partial" | "never" | "ok" = "stale";
    const orders = async (request: AnalyticsSourceRequest) => {
      const s = ordersFixture(request);
      if (mode === "stale") s.feeds[0]!.lastSuccessAt = new Date(analyticsTestTime - 16 * 60_000).toISOString();
      if (mode === "partial") s.feeds[1]!.coverage = "partial";
      if (mode === "never") s.feeds[1] = { ...s.feeds[1]!, lastSuccessAt: null, syncState: "error", orders: [] };
      return s;
    };
    const { post, envelope } = await start({ analyticsSources: { ...base, orders, adPlatforms: undefined } });
    const stale = await post(envelope("overviewSummary"));
    expect(stale.body.dataState).toBe("stale");
    expect(stale.body.sourceFreshness[0]).toMatchObject({ freshnessState: "error", staleReasonCode: "SOURCE_STALE" });
    expect(stale.body.sourceFreshness.at(-1)).toMatchObject({ freshnessState: "neverSynced", staleReasonCode: "SOURCE_UNCONFIGURED" });
    mode = "partial";
    const partial = await post(envelope("attribution"));
    expect(partial.body.dataState).toBe("partial");
    expect(partial.body.coverage).toMatchObject({ complete: false, expectedCount: 4 });
    mode = "never";
    const never = await post(envelope("overviewSummary"));
    expect(never.status).toBe(200);
    expect(never.body.data.orders).toMatchObject({ state: "unknown", value: null, reasonCode: "ORDER_FEED_NEVER_SYNCED" });
    expect(never.body.data.daily.every((d: { tiktok: unknown }) => d.tiktok === null)).toBe(true);
    expect(readResponseSchema(analyticsViewSchemas.overviewSummary!).safeParse(never.body).success).toBe(true);
    const paid = await post(envelope("paidMedia", { rights: "all", platform: "all" }));
    expect(paid.status).toBe(200);
    expect(paid.body.data.sources).toEqual([{ source: "adPlatforms", state: "unconfigured", reasonCode: "SOURCE_UNCONFIGURED" }]);
  });

  it("refuses forged filters, periods and envelopes with a canonical validation error and no source access", async () => {
    const { calls, sources } = counted();
    const { post, envelope } = await start({ analyticsSources: sources });
    const forged: [string, unknown, Record<string, unknown>][] = [
      ["overviewSummary", { scenario: "happy" }, {}], ["overviewSummary", { fixture: "FX-01-happy-read" }, {}], ["attribution", { workspaceId: "other" }, {}],
      ["paidMedia", { rights: "all", platform: "google" }, {}], ["customerJourney", { preset: "allTime" }, {}],
      ["overviewSummary", {}, { period: { startAt: "2026-10-01", endAt: "2026-12-01", timezone: "UTC", basis: "eventTime" } }],
      ["overviewSummary", {}, { period: { startAt: "2026-10-01", endAt: "2026-10-02", timezone: "UTC", basis: "observationTime" } }],
      ["overviewSummary", { preset: "last7Days" }, { period: { startAt: "2026-10-01", endAt: "2026-10-02", timezone: "UTC", basis: "eventTime" } }],
      ["overviewSummary", {}, { sort: [{ field: "orders", direction: "desc" }] }], ["overviewSummary", {}, { page: { cursor: "next", limit: 50 } }],
      ["overviewSummary", {}, { schemaVersion: "2020-01-01" }], ["overviewSummary", {}, { adapterOverride: "demo" }], ["overviewSummary", {}, { requestId: "" }],
    ];
    for (const [view, filters, overrides] of forged) {
      const result = await post(envelope(view, filters, overrides));
      expect(result.status, JSON.stringify([view, filters, overrides])).toBe(400);
      expectCanonical(result.body, "VALIDATION_FAILED");
    }
    expect(calls).toEqual([]);
    // Valid explicit period is accepted.
    const explicit = await post(envelope("overviewSummary", {}, { period: { startAt: "2026-10-01", endAt: "2026-10-31", timezone: analyticsTestTimezone, basis: "eventTime" } }));
    expect(explicit.status).toBe(200);
    expect(explicit.body.data.window).toEqual({ start: "2026-10-01", end: "2026-10-31", timezone: analyticsTestTimezone });
  });

  it("degrades a malformed source to its own invalid state, refuses a foreign source scope, and keeps other read models routed as before", async () => {
    let answer: unknown = null;
    const { post, envelope } = await start({ analyticsSources: { ...syntheticAnalyticsSources(), orders: async request => answer ?? ordersFixture(request) } });
    answer = { scope: analyticsTestScope, window: { start: "2026-10-08", end: "2026-11-06", timezone: analyticsTestTimezone }, feeds: [{ feedRef: "x", observedAt: "2026-13-01T00:00:00Z" }] };
    const malformed = await post(envelope("overviewSummary"));
    expect(malformed.status).toBe(200);
    expect(malformed.body.data.sources[0]).toEqual({ source: "orders", state: "invalid", reasonCode: "SOURCE_RESPONSE_INVALID" });
    expect(malformed.body.data.orders).toMatchObject({ state: "unknown", value: null, reasonCode: "ORDERS_SOURCE_INVALID" });
    expect(malformed.body.data.measures.find((m: { key: string }) => m.key === "paidMediaSpend").value).toBe(650_000);
    answer = { ...ordersFixture({ scope: analyticsTestScope, window: { start: "2026-10-08", end: "2026-11-06", timezone: analyticsTestTimezone } }), scope: { ...analyticsTestScope, workspaceId: "foreign" } };
    const foreign = await post(envelope("overviewSummary"));
    expect(foreign.status).toBe(403);
    expectCanonical(foreign.body, "SOURCE_SCOPE_DENIED");
    answer = null;
    expect((await post(envelope("overviewSummary"))).status).toBe(200);
    expect((await post(envelope("discoverySummary"))).status).toBe(200);
    expect((await post(envelope("noSuchView"))).status).toBe(400);
  });
});
