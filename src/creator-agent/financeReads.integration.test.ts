// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract";
import { adapterErrorBodySchema } from "../adapter/wire";
import { viewSchemas } from "../adapter/viewSchemas";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { createHttpTransport } from "../adapter/httpTransport";
import { financeViewKeys, type FinanceViewKey } from "./finance/contract";
import { FinanceError } from "./finance/source";
import type { FinanceSourceReader } from "./finance/source";
import { financeTestSource, financeSnapshot, financeTestFilters, financeTestScope, financeTestTime } from "./finance/fixtures.testkit";
import { financeRecord } from "./finance/fixtures.testkit";

const apps: ReturnType<typeof createAgentServer>[] = [];
const requestedScope = { workspaceId: financeTestScope.workspaceId, accountIds: [financeTestScope.accountId], environment: "sandbox" as const };
const PROVIDER_SECRET = "synthetic-provider-session-credential-not-real-0001";
type TestOptions = Omit<Partial<AgentServerOptions>, "financeSource"> & { financeSource?: FinanceSourceReader | FinanceSourceReader["read"] };
async function start(extra: TestOptions = {}) {
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: financeTestScope.workspaceId, accountId: financeTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => Date.parse(financeTestTime) }, ...extra, financeSource: typeof extra.financeSource === "function" ? financeTestSource(extra.financeSource) : extra.financeSource });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test service");
  const origin = `http://127.0.0.1:${address.port}`;
  const read = async (viewKey: string, filters: unknown, options: { token?: string | null; scope?: unknown; cursor?: string | null; signal?: AbortSignal } = {}) => {
    const token = options.token === undefined ? SYNTHETIC_READ_TOKEN : options.token;
    const response = await fetch(`${origin}/v1/read`, { method: "POST", signal: options.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-finance-read", requestedScope: options.scope ?? requestedScope,
        viewKey, filters, period: null, sort: [], page: { cursor: options.cursor ?? null, limit: 50 } }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
  };
  return { app, origin, read };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("authenticated finance and payable reads (THO-303, THO-300)", () => {
  it("refuses an expired independent access grant over actual HTTP without returning retained finance facts", async () => {
    let clock = Date.parse(financeTestTime);
    const snapshot = financeSnapshot("financeDashboard");
    const { read } = await start({ operations: { now: () => clock }, financeSource: async () => snapshot });
    const first = await read("financeDashboard", {});
    expect(first.status).toBe(200);
    expect(first.body.data.readAccess).toEqual({ validUntil: snapshot.readAccess.validUntil });
    clock += 15 * 60_000;
    const expired = await read("financeDashboard", {});
    expect(expired.status).toBe(403);
    expect(expired.body).not.toHaveProperty("data");
    expect(expired.text).not.toContain("Synthetic October");
  });
  it.each(financeViewKeys)("%s: unconfigured source is a typed INTEGRATION_PENDING error with no data, for reader and reviewer", async viewKey => {
    const { read } = await start();
    for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) {
      const result = await read(viewKey, financeTestFilters[viewKey], { token });
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("no-store");
      const body = adapterErrorBodySchema.parse(result.body);
      expect(body).toMatchObject({ code: "INTEGRATION_PENDING", requestId: "synthetic-finance-read", executionCertainty: "notApplied", reasonCodes: [["commissionLedger","settlementDetail","payableDetail"].includes(viewKey)?"SETTLEMENT_SOURCE_UNCONFIGURED":"FINANCE_SOURCE_UNCONFIGURED"] });
      expect(result.body).not.toHaveProperty("data");
      expect(result.text).not.toMatch(/minorUnits|grossSales|finance-demo/);
    }
  });

  it.each(financeViewKeys)("%s: unauthenticated, wrong-token and wrong-workspace reads are denied before source access (AD-01)", async viewKey => {
    let reads = 0;
    const { read } = await start({ financeSource: async () => { reads++; return financeSnapshot(viewKey); } });
    for (const token of [null, "synthetic-wrong-token-not-a-secret-000000001"]) {
      const denied = await read(viewKey, financeTestFilters[viewKey], { token });
      expect(denied.status).toBe(401);
      expect(denied.body).toMatchObject({ code: "AUTH_REQUIRED", message: "Access is not currently permitted.", executionCertainty: "notApplied" });
      expect(denied.body).not.toHaveProperty("data");
    }
    for (const scope of [{ ...requestedScope, workspaceId: "foreign-workspace" }, { ...requestedScope, accountIds: ["foreign-account"] },
      { ...requestedScope, environment: "production" }]) {
      const foreign = await read(viewKey, financeTestFilters[viewKey], { scope });
      expect(foreign.status).toBe(403);
      expect(foreign.body).toMatchObject({ code: "FORBIDDEN", executionCertainty: "notApplied" });
      expect(foreign.body).not.toHaveProperty("data");
    }
    expect(reads).toBe(0);
  });

  it.each(financeViewKeys)("%s: a configured source answer validates against the frontend envelope and view schema (AD-09)", async viewKey => {
    const { read } = await start({ financeSource: async () => financeSnapshot(viewKey) });
    const result = await read(viewKey, financeTestFilters[viewKey], { token: SYNTHETIC_REVIEW_TOKEN });
    expect(result.status).toBe(200);
    const body = readResponseSchema(viewSchemas[viewKey]!).parse(result.body);
    expect(body).toMatchObject({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-finance-read", dataState: "ready",
      scope: { ...requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, page: { nextCursor: null, hasMore: false },
      coverage: { complete: true, expectedCount: 1, observedCount: 1 } });
    expect(body.sourceFreshness).toHaveLength(1);
    expect(body.capabilities.some(c => c.state === "available")).toBe(false);
  });

  it("denies every finance intent to a reader with REVIEWER_REQUIRED and never exposes Pay, close or export as available", async () => {
    const { read } = await start({ financeSource: async (_scope, request) => financeSnapshot(request.viewKey) });
    for (const viewKey of ["settlementDetail", "payableDetail", "periodClose", "closePackage"] as const) {
      const asReader = await read(viewKey, financeTestFilters[viewKey]);
      expect(asReader.body.capabilities.length).toBeGreaterThan(0);
      for (const capability of asReader.body.capabilities) expect(capability).toMatchObject({ state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] });
      const asReviewer = await read(viewKey, financeTestFilters[viewKey], { token: SYNTHETIC_REVIEW_TOKEN });
      for (const capability of asReviewer.body.capabilities) expect(["held", "unsupported"]).toContain(capability.state);
    }
  });

  it.each(financeViewKeys)("%s: a non-null cursor is INVALID_CURSOR and demo scenario filters are refused (D-11)", async viewKey => {
    let reads = 0;
    const { read } = await start({ financeSource: async () => { reads++; return financeSnapshot(viewKey); } });
    expect((await read(viewKey, financeTestFilters[viewKey], { cursor: "sc1.synthetic-cursor" })).body).toMatchObject({ code: "INVALID_CURSOR" });
    expect((await read(viewKey, { ...financeTestFilters[viewKey], scenario: "stale" })).status).toBe(400);
    expect(reads).toBe(0);
  });

  it("carries stale and partial state, period and currency without turning unknown into zero (AD-03)", async () => {
    let clock = Date.parse(financeTestTime);
    const { read } = await start({ operations: { now: () => clock }, financeSource: async (_scope, request) => request.viewKey === "commissionLedger"
      ? financeSnapshot("commissionLedger", { coverage: { state: "partial", expectedCount: 4, observedCount: 3, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } })
      : financeSnapshot(request.viewKey, {}, clock) });
    const partial = await read("commissionLedger", {});
    expect(partial.body).toMatchObject({ dataState: "partial", data: { currency: "USD" },
      coverage: { expectedCount: 4, observedCount: 3, missingCount: 1, complete: false, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } });
    const dashboard = await read("financeDashboard", {});
    expect(dashboard.body.data.pnl.ytd).toMatchObject({ state: "unknown", value: null, reasonCode: "YTD_REPORT_NOT_RECEIVED" });
    const close = await read("closePackage", { period: "2026-10" });
    expect(close.body.data.period).toBe("2026-10");
    clock = Date.parse("2026-11-07T12:00:00.000Z");
    const stale = await read("financeDashboard", {});
    expect(stale.body).toMatchObject({ dataState: "stale", coverage: { complete: false, reasonCodes: ["FINANCE_SOURCE_STALE"] } });
    expect(stale.body.sourceFreshness[0]).toMatchObject({ staleReasonCode: "FINANCE_SOURCE_STALE", lastSourceSuccessAt: "2026-11-06T11:00:00.000Z" });
  });

  it("maps source denial, failure, invalid answers and missing records to typed errors without source text (AD-02)", async () => {
    let mode = "deny";
    const { read } = await start({ financeSource: async (_scope, request) => {
      if (mode === "deny") throw new FinanceError(`Bearer ${PROVIDER_SECRET}`, 403);
      if (mode === "fail") throw new Error(`upstream refused token=${PROVIDER_SECRET}`);
      if (mode === "invalid") return { ...financeSnapshot(request.viewKey), secret: PROVIDER_SECRET };
      return financeSnapshot(request.viewKey, { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } });
    } });
    const expected: Record<string, [number, string]> = { deny: [403, "SOURCE_AUTHORITY_DENIED"], fail: [503, "SOURCE_UNAVAILABLE"],
      invalid: [502, "SOURCE_RESPONSE_INVALID"], missing: [404, "RECORD_NOT_FOUND"] };
    for (const [next, [status, code]] of Object.entries(expected)) {
      mode = next;
      const result = await read("payableDetail", { payableId: "PAY-0012" });
      expect(result.status, next).toBe(status);
      expect(result.body).toMatchObject({ code, executionCertainty: "notApplied" });
      expect(result.body).not.toHaveProperty("data");
      expect(result.text).not.toContain(PROVIDER_SECRET);
      expect(result.text).not.toContain(SYNTHETIC_READ_TOKEN);
    }
    mode = "deny";
    const denied = await read("payableDetail", { payableId: "PAY-0012" });
    expect(denied.body.message).toBe("Access is not currently permitted.");
    expect(denied.body).not.toHaveProperty("reasonCodes");
  });

  it("never echoes the bearer credential or source version in a successful payload", async () => {
    const { read } = await start({ financeSource: async (_scope, request) => financeSnapshot(request.viewKey, { version: "synthetic-private-source-version" }) });
    for (const viewKey of financeViewKeys) {
      const result = await read(viewKey, financeTestFilters[viewKey], { token: SYNTHETIC_REVIEW_TOKEN });
      expect(result.status).toBe(200);
      for (const secret of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, "synthetic-private-source-version"]) expect(result.text).not.toContain(secret);
    }
  });

  it("aborts the source read when the client disconnects (cancellation)", async () => {
    let signal: AbortSignal | undefined, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { read } = await start({ financeSource: (_scope, _request, options) => { signal = options.signal; entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const pending = read("commissionLedger", {}, { signal: controller.signal }).catch(error => error);
    await started;
    controller.abort();
    await pending;
    await expect.poll(() => signal?.aborted).toBe(true);
  });

  it("isolates scope per instance and caches nothing between reads (cache isolation)", async () => {
    let calls = 0;
    const scopes: unknown[] = [];
    const { read } = await start({ financeSource: async (scope, request) => { calls++; scopes.push(scope); return financeSnapshot(request.viewKey, { version: `synthetic-v${calls}` }); } });
    const one = await read("commissionLedger", {});
    const two = await read("commissionLedger", {});
    expect(calls).toBe(2);
    expect(one.body.dataVersion).not.toBe(two.body.dataVersion);
    expect(scopes).toEqual([financeTestScope, financeTestScope]);
  });

  it("shares the per-principal read limit with other reads (FHAD-05 rate limit)", async () => {
    const { read } = await start();
    let last: Awaited<ReturnType<typeof read>> | undefined;
    for (let i = 0; i < 121; i++) last = await read("financeDashboard", {});
    expect(last!.status).toBe(429);
    expect(last!.body).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: expect.any(Number) });
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("reports the finance source and every finance execution as not connected in capabilities", async () => {
    const { origin } = await start();
    const caps = await (await fetch(`${origin}/v1/capabilities`, { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).json();
    expect(caps.financeReads).toEqual({ sourceAuthority: "notConnected", views: "read-only-projections", paymentExecution: "notConnected",
      closeExecution: "notConnected", exportExecution: "notConnected" });
  });

  it("reaches the frontend through the real HTTP transport and live adapter as a typed unavailable error, or as validated data", async () => {
    let configured = false;
    const { origin } = await start({ financeSource: async (_scope, request) => configured ? financeSnapshot(request.viewKey) : Promise.reject(new Error("offline")) });
    const readerFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${SYNTHETIC_READ_TOKEN}`);
      return fetch(url, { ...init, headers });
    };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: readerFetch }) });
    const request = (viewKey: FinanceViewKey) => ({ schemaVersion: SCHEMA_VERSION, operation: "readView" as const, viewKey, requestedScope,
      filters: financeTestFilters[viewKey], period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "synthetic-adapter-read" });
    for (const viewKey of financeViewKeys)
      await expect(adapter.readView(request(viewKey))).rejects.toMatchObject({ category: "unavailable", body: { code: "SOURCE_UNAVAILABLE" } });
    configured = true;
    for (const viewKey of financeViewKeys) {
      const response = await adapter.readView(request(viewKey));
      expect(response.dataState, viewKey).toBe("ready");
      expect(response.data, viewKey).not.toBeNull();
    }
    const { origin: pendingOrigin } = await start();
    const pending = createLiveAdapter("sandbox", { transport: createHttpTransport(pendingOrigin, { fetch: readerFetch }) });
    await expect(pending.readView(request("payableDetail"))).rejects.toMatchObject({ category: "unavailable", body: { code: "INTEGRATION_PENDING" } });
  });

  it("serves exactly the finance view keys the frontend registry validates", () => {
    const registered = (["commissionLedger", "settlementDetail", "payableDetail", "financeDashboard", "periodClose", "closePackage", "monthsHistory", "reportManifest"] as FinanceViewKey[]);
    expect([...financeViewKeys].sort()).toEqual(registered.sort());
    for (const viewKey of financeViewKeys) expect(viewSchemas[viewKey], viewKey).toBeDefined();
  });
  it.each(financeViewKeys)("%s refuses a demo identity at the authenticated native boundary", async viewKey => {
    const record = { ...financeRecord(viewKey) as object, datasetKey: "demo-only-record" };
    const { read } = await start({ financeSource: async () => financeSnapshot(viewKey, { record }) });
    const result = await read(viewKey, financeTestFilters[viewKey]);
    expect(result.status).toBe(502); expect(result.body).not.toHaveProperty("data");
  });

  it.each([403, 409] as const)("rejects a source authority change (%s) before the HTTP read publishes", async status => {
    let entered!: () => void, release!: () => void, changed = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const source: FinanceSourceReader = {
      async read(_scope, request, options) { const captured = financeSnapshot(request.viewKey, { principalRef: options.principal.principalRef }); entered(); await gate; return captured; },
      assertCurrent() { if (changed) throw new FinanceError("private-revoked-proof", status); },
    };
    const { read } = await start({ financeSource: source });
    const pending = read("commissionLedger", {}); await started; changed = true; release();
    const result = await pending;
    expect(result.status).toBe(status); expect(result.body).not.toHaveProperty("data"); expect(result.text).not.toContain("private-revoked-proof");
  });

  it.each(["payableDetail", "periodClose"] as const)("%s preserves partial and expired absence through HTTP", async viewKey => {
    let stale = false;
    const { read } = await start({ financeSource: async () => financeSnapshot(viewKey, { record: null,
      ...(stale ? { validUntil: "2026-11-06T11:59:59.000Z" } : {}),
      coverage: stale ? { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } : { state: "partial", expectedCount: null, observedCount: null, reasonCodes: ["SOURCE_DEFERRED"] } }) });
    expect((await read(viewKey, financeTestFilters[viewKey])).body).toMatchObject({ dataState: "partial", data: null, coverage: { complete: false } });
    stale = true;
    expect((await read(viewKey, financeTestFilters[viewKey])).body).toMatchObject({ dataState: "stale", data: null, coverage: { complete: false } });
  });

});
