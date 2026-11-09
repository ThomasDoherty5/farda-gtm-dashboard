// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract";
import { adapterErrorBodySchema } from "../adapter/wire";
import { viewSchemas } from "../adapter/viewSchemas";
import { opsViewSchemas } from "../adapter/viewSchemas/ops";
import { nativeOrderRecord } from "./operationsReads/fixtures.testkit";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { createHttpTransport } from "../adapter/httpTransport";
import { operationsReadViewKeys, type OperationsReadViewKey } from "./operationsReads/contract";
import { OperationsReadError } from "./operationsReads/source";
import type { OperationsReadSourceReader } from "./operationsReads/source";
import { operationsReadTestFilters, operationsReadTestScope, operationsReadTestTime, operationsRecord, operationsSnapshot, syntheticCustomer, syntheticAuditReason } from "./operationsReads/fixtures.testkit";
import { operationsTestSource } from "./operationsReads/fixtures.testkit";

const apps: ReturnType<typeof createAgentServer>[] = [];
const requestedScope = { workspaceId: operationsReadTestScope.workspaceId, accountIds: [operationsReadTestScope.accountId], environment: "sandbox" as const };
const PROVIDER_SECRET = "synthetic-provider-session-credential-not-real-0002";
type TestOptions = Omit<Partial<AgentServerOptions>, "operationsReadSource"> & { operationsReadSource?: OperationsReadSourceReader | OperationsReadSourceReader["read"] };
async function start(extra: TestOptions = {}) {
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: operationsReadTestScope.workspaceId, accountId: operationsReadTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => Date.parse(operationsReadTestTime) }, ...extra, operationsReadSource: typeof extra.operationsReadSource === "function" ? operationsTestSource(extra.operationsReadSource) : extra.operationsReadSource });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test service");
  const origin = `http://127.0.0.1:${address.port}`;
  const read = async (viewKey: string, filters: unknown, options: { token?: string | null; scope?: unknown; cursor?: string | null; signal?: AbortSignal } = {}) => {
    const token = options.token === undefined ? SYNTHETIC_READ_TOKEN : options.token;
    const response = await fetch(`${origin}/v1/read`, { method: "POST", signal: options.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-operations-read", requestedScope: options.scope ?? requestedScope,
        viewKey, filters, period: null, sort: [], page: { cursor: options.cursor ?? null, limit: 50 } }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
  };
  return { app, origin, read };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("authenticated operations reads (THO-301, THO-367)", () => {
  it.each(operationsReadViewKeys)("%s: unconfigured source is a typed INTEGRATION_PENDING error with no data, for reader and reviewer", async viewKey => {
    const { read } = await start();
    for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) {
      const result = await read(viewKey, operationsReadTestFilters[viewKey], { token });
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("no-store");
      const body = adapterErrorBodySchema.parse(result.body);
      expect(body).toMatchObject({ code: "INTEGRATION_PENDING", requestId: "synthetic-operations-read", executionCertainty: "notApplied", reasonCodes: ["OPERATIONS_SOURCE_UNCONFIGURED"] });
      expect(result.body).not.toHaveProperty("data");
      expect(result.text).not.toMatch(/operations-demo|minorUnits|TEST-SH|Testville/);
    }
  });

  it.each(operationsReadViewKeys)("%s: unauthenticated, wrong-token and foreign workspace/account/environment reads are denied before source access (AD-01)", async viewKey => {
    let reads = 0;
    const { read } = await start({ operationsReadSource: async () => { reads++; return operationsSnapshot(viewKey); } });
    for (const token of [null, "synthetic-wrong-token-not-a-secret-000000002"]) {
      const denied = await read(viewKey, operationsReadTestFilters[viewKey], { token });
      expect(denied.status).toBe(401);
      expect(denied.body).toMatchObject({ code: "AUTH_REQUIRED", message: "Access is not currently permitted.", executionCertainty: "notApplied" });
      expect(denied.body).not.toHaveProperty("data");
    }
    for (const scope of [{ ...requestedScope, workspaceId: "foreign-workspace" }, { ...requestedScope, accountIds: ["foreign-account"] },
      { ...requestedScope, environment: "production" }]) {
      const foreign = await read(viewKey, operationsReadTestFilters[viewKey], { scope });
      expect(foreign.status).toBe(400);
      expect(foreign.body).toMatchObject({ code: "INVALID_INPUT", executionCertainty: "notApplied" });
      expect(foreign.body).not.toHaveProperty("data");
    }
    expect(reads).toBe(0);
  });

  it.each(operationsReadViewKeys)("%s: a configured source answer validates against the frontend envelope and view schema (AD-09)", async viewKey => {
    const seen: unknown[] = [];
    const { read } = await start({ operationsReadSource: async (scope, request) => { seen.push({ scope, request }); return operationsSnapshot(viewKey); } });
    const result = await read(viewKey, operationsReadTestFilters[viewKey], { token: SYNTHETIC_REVIEW_TOKEN });
    expect(result.status).toBe(200);
    const body = readResponseSchema(viewSchemas[viewKey]!).parse(result.body);
    expect(body).toMatchObject({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-operations-read", dataState: "ready",
      scope: { ...requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, page: { nextCursor: null, hasMore: false },
      coverage: { complete: true, expectedCount: 1, observedCount: 1 } });
    expect(body.sourceFreshness).toHaveLength(1);
    expect(body.capabilities.some(c => c.state === "available")).toBe(false);
    // Exact scope and filters reach the source; nothing is widened or defaulted.
    expect(seen).toEqual([{ scope: operationsReadTestScope, request: { viewKey, filters: operationsReadTestFilters[viewKey] } }]);
  });

  it("denies every operations intent to a reader with REVIEWER_REQUIRED and holds them, not connected, for a reviewer", async () => {
    const { read } = await start({ operationsReadSource: async (_scope, request) => operationsSnapshot(request.viewKey) });
    for (const viewKey of ["shippingException", "returnDetail", "orderCustomer"] as const) {
      const asReader = await read(viewKey, operationsReadTestFilters[viewKey]);
      expect(asReader.body.capabilities.length).toBeGreaterThan(0);
      for (const capability of asReader.body.capabilities) expect(capability).toMatchObject({ state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] });
      const asReviewer = await read(viewKey, operationsReadTestFilters[viewKey], { token: SYNTHETIC_REVIEW_TOKEN });
      for (const capability of asReviewer.body.capabilities) expect(capability).toMatchObject({ state: "held", reasonCodes: ["OPERATIONS_ACTIONS_NOT_CONNECTED"] });
    }
  });

  it.each(operationsReadViewKeys)("%s: a non-null cursor is INVALID_CURSOR and demo scenario, fixture and unknown filters are refused (D-11)", async viewKey => {
    let reads = 0;
    const { read } = await start({ operationsReadSource: async () => { reads++; return operationsSnapshot(viewKey); } });
    expect((await read(viewKey, operationsReadTestFilters[viewKey], { cursor: "sc1.synthetic-cursor" })).body).toMatchObject({ code: "INVALID_CURSOR" });
    for (const extra of [{ scenario: "stale" }, { fixture: "x" }, { unknownFilter: "x" }, { home: "H4" }]) {
      const refused = await read(viewKey, { ...operationsReadTestFilters[viewKey], ...extra });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(reads).toBe(0);
  });

  it("binds each detail read to its exact address and refuses a source that answers another record", async () => {
    const { read } = await start({ operationsReadSource: async (_scope, request) => operationsSnapshot(request.viewKey) });
    const mismatches: [OperationsReadViewKey, Record<string, unknown>][] = [["orderDetail", { orderId: "TEST-SH-1031" }], ["orderCustomer", { orderId: "TEST-SH-1031" }],
      ["returnDetail", { returnId: "TEST-RET-099" }], ["shippingException", { shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-999" }], ["fulfillmentAnalytics", { days: 7 }]];
    for (const [viewKey, filters] of mismatches) {
      const result = await read(viewKey, filters);
      expect(result.status, viewKey).toBe(502);
      expect(result.body).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["OPERATIONS_RECORD_ADDRESS_MISMATCH"] });
      expect(result.body).not.toHaveProperty("data");
    }
    expect((await read("fulfillmentAnalytics", { days: "14" })).status).toBe(400);
  });

  it("carries stale, partial and empty states with counts and reasons, without turning unknown into zero (AD-03)", async () => {
    let clock = Date.parse(operationsReadTestTime);
    const { read } = await start({ operations: { now: () => clock }, operationsReadSource: async (_scope, request) => {
      if (request.viewKey === "operationsShipping") return operationsSnapshot("operationsShipping", { coverage: { state: "partial", expectedCount: 9, observedCount: 7, reasonCodes: ["CARRIER_SCANS_DEFERRED"] } });
      if (request.viewKey === "opsHealth") return operationsSnapshot("opsHealth", { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } });
      if (request.viewKey === "orderDetail") return operationsSnapshot("orderDetail", { record: nativeOrderRecord("TEST-SH-1044") });
      return operationsSnapshot(request.viewKey);
    } });
    const partial = await read("operationsShipping", {});
    expect(partial.body).toMatchObject({ dataState: "partial", coverage: { expectedCount: 9, observedCount: 7, missingCount: 2, complete: false, reasonCodes: ["CARRIER_SCANS_DEFERRED"] } });
    expect(partial.body.data.shipments.length).toBeGreaterThan(0);
    const empty = await read("opsHealth", {});
    expect(empty.body).toMatchObject({ dataState: "empty", data: null, coverage: { expectedCount: 0, observedCount: 0, complete: true } });
    const order = await read("orderDetail", { orderId: "TEST-SH-1044" });
    expect(order.status).toBe(200);
    expect(order.body.data.total).toMatchObject({ state: "unknown", value: null, reasonCode: "PAYMENT_RECEIPT_UNAVAILABLE" });
    expect(order.body.data.refunded).toMatchObject({ state: "unknown", value: null });
    clock = Date.parse("2026-11-06T12:10:00.000Z");
    const stale = await read("operationsOverview", {});
    expect(stale.body).toMatchObject({ dataState: "stale", coverage: { complete: false, reasonCodes: ["OPERATIONS_SOURCE_STALE"] } });
    expect(stale.body.sourceFreshness[0]).toMatchObject({ staleReasonCode: "OPERATIONS_SOURCE_STALE", lastSourceSuccessAt: "2026-11-06T11:55:00.000Z" });
    expect(stale.body.data).not.toBeNull();
  });

  it("maps source denial, failure, invalid answers, timeouts and missing records to typed errors without source text (AD-02)", async () => {
    let mode = "deny";
    const { read } = await start({ operationsReadSource: async (_scope, request) => {
      if (mode === "deny") throw new OperationsReadError(`Bearer ${PROVIDER_SECRET}`, 403);
      if (mode === "fail") throw new Error(`upstream refused token=${PROVIDER_SECRET}`);
      if (mode === "invalid") return { ...operationsSnapshot(request.viewKey), secret: PROVIDER_SECRET };
      return operationsSnapshot(request.viewKey, { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } });
    } });
    const expected: Record<string, [number, string]> = { deny: [403, "SOURCE_AUTHORITY_DENIED"], fail: [503, "SOURCE_UNAVAILABLE"],
      invalid: [502, "SOURCE_RESPONSE_INVALID"], missing: [404, "RECORD_NOT_FOUND"] };
    for (const viewKey of ["orderDetail", "orderCustomer", "shippingException", "returnDetail"] as const) {
      for (const [next, [status, code]] of Object.entries(expected)) {
        mode = next;
        const result = await read(viewKey, operationsReadTestFilters[viewKey]);
        expect(result.status, `${viewKey} ${next}`).toBe(status);
        expect(result.body).toMatchObject({ code, executionCertainty: "notApplied" });
        expect(result.body).not.toHaveProperty("data");
        expect(result.text).not.toContain(PROVIDER_SECRET);
        expect(result.text).not.toContain(SYNTHETIC_READ_TOKEN);
      }
    }
    mode = "deny";
    const denied = await read("orderDetail", { orderId: "TEST-SH-1042" });
    expect(denied.body.message).toBe("Access is not currently permitted.");
    expect(denied.body).not.toHaveProperty("reasonCodes");
  });

  it("answers a hung source as a typed 504 TIMEOUT", async () => {
    // The reader's 10 s bound is below the 15 s HTTP request timeout; the unit test proves the bound itself with a short timeout.
    const { read } = await start({ operationsReadSource: (_scope, _request, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
    const result = await read("operationsOverview", {});
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ code: "TIMEOUT", reasonCodes: ["OPERATIONS_SOURCE_TIMEOUT"], executionCertainty: "notApplied" });
  }, 20_000);

  it("orderCustomer carries only what the frontend schema allows, and no customer data for a reader (AD-02, personal data)", async () => {
    const record = operationsRecord("orderCustomer");
    const { read } = await start({ operationsReadSource: async () => operationsSnapshot("orderCustomer", { version: "synthetic-private-source-version", record }) });
    const asReader = await read("orderCustomer", { orderId: "TEST-SH-1042" });
    expect(asReader.status).toBe(200);
    expect(asReader.body.data).toMatchObject({ access: { state: "denied", reason: "CUSTOMER_REVEAL_AUTHORITY_NOT_CONNECTED" }, revealed: null, audit: [] });
    for (const value of [...Object.values(syntheticCustomer), "555-0100", "Synthetic Way", "synthetic-provider-customer-7", "synthetic-private-source-version", SYNTHETIC_READ_TOKEN])
      expect(asReader.text).not.toContain(value);
    const asReviewer = await read("orderCustomer", { orderId: "TEST-SH-1042" }, { token: SYNTHETIC_REVIEW_TOKEN });
    const parsed = readResponseSchema(opsViewSchemas.orderCustomer!).parse(asReviewer.body);
    expect(Object.keys(asReviewer.body.data).sort()).toEqual(["access", "audit", "datasetKey", "nativeEvents", "orderRef", "provenance", "reportingScope", "revealed", "sourceLinks", "synthetic"]);
    expect(asReviewer.body.data).toMatchObject({ nativeEvents: [], reportingScope: null, sourceLinks: [] });
    expect(asReviewer.body.data).toMatchObject({ revealed: null, audit: [], access: { state: "denied" } });
    for (const value of [...Object.values(syntheticCustomer), syntheticAuditReason]) expect(asReviewer.text).not.toContain(value);
    expect(parsed.capabilities).toEqual([{ actionKind: "revealCustomerDetails", state: "held", reasonCodes: ["OPERATIONS_ACTIONS_NOT_CONNECTED"] }]);
    for (const value of ["555-0100", "Synthetic Way", "synthetic-provider-customer-7", "synthetic-private-source-version", SYNTHETIC_REVIEW_TOKEN]) expect(asReviewer.text).not.toContain(value);
    expect(asReader.body.dataVersion).not.toBe(asReviewer.body.dataVersion);
  });

  it("never echoes the bearer credential or source version in a successful payload", async () => {
    const { read } = await start({ operationsReadSource: async (_scope, request) => operationsSnapshot(request.viewKey, { version: "synthetic-private-source-version" }) });
    for (const viewKey of operationsReadViewKeys) {
      const result = await read(viewKey, operationsReadTestFilters[viewKey], { token: SYNTHETIC_REVIEW_TOKEN });
      expect(result.status).toBe(200);
      for (const secret of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, "synthetic-private-source-version"]) expect(result.text).not.toContain(secret);
    }
  });

  it("aborts the source read when the client disconnects (cancellation)", async () => {
    let signal: AbortSignal | undefined, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { read } = await start({ operationsReadSource: (_scope, _request, options) => { signal = options.signal; entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const pending = read("operationsOverview", {}, { signal: controller.signal }).catch(error => error);
    await started;
    controller.abort();
    await pending;
    await expect.poll(() => signal?.aborted).toBe(true);
  });

  it("isolates scope per instance and caches nothing between reads (cache isolation)", async () => {
    let calls = 0;
    const scopes: unknown[] = [];
    const { read } = await start({ operationsReadSource: async (scope, request) => { calls++; scopes.push(scope); return operationsSnapshot(request.viewKey, { version: `synthetic-v${calls}` }); } });
    const one = await read("operationsOverview", {});
    const two = await read("operationsOverview", {});
    expect(calls).toBe(2);
    expect(one.body.dataVersion).not.toBe(two.body.dataVersion);
    expect(scopes).toEqual([operationsReadTestScope, operationsReadTestScope]);
  });

  it("shares the per-principal read limit with other reads (FHAD-05 rate limit)", async () => {
    const { read } = await start();
    for (let i = 0; i < 60; i++) await read("financeDashboard", {});
    let last: Awaited<ReturnType<typeof read>> | undefined;
    for (let i = 0; i < 61; i++) last = await read("operationsOverview", {});
    expect(last!.status).toBe(429);
    expect(last!.body).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: expect.any(Number) });
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("reports the operations source and every operations execution as not connected in capabilities", async () => {
    const { origin } = await start();
    const caps = await (await fetch(`${origin}/v1/capabilities`, { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).json();
    expect(caps.operationsReads).toEqual({ sourceAuthority: "notConnected", views: "read-only-projections", shippingDecisionExecution: "notConnected",
      returnExecution: "notConnected", customerReveal: "notConnected" });
  });

  it("reaches the frontend through the real HTTP transport and live adapter as a typed unavailable error, or as validated data", async () => {
    let configured = false;
    const { origin } = await start({ operationsReadSource: async (_scope, request) => configured ? operationsSnapshot(request.viewKey) : Promise.reject(new Error("offline")) });
    const readerFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${SYNTHETIC_READ_TOKEN}`);
      return fetch(url, { ...init, headers });
    };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: readerFetch }) });
    const request = (viewKey: OperationsReadViewKey) => ({ schemaVersion: SCHEMA_VERSION, operation: "readView" as const, viewKey, requestedScope,
      filters: operationsReadTestFilters[viewKey], period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "synthetic-adapter-read" });
    for (const viewKey of operationsReadViewKeys)
      await expect(adapter.readView(request(viewKey))).rejects.toMatchObject({ category: "unavailable", body: { code: "SOURCE_UNAVAILABLE" } });
    configured = true;
    for (const viewKey of operationsReadViewKeys) {
      const response = await adapter.readView(request(viewKey));
      expect(response.dataState, viewKey).toBe("ready");
      expect(response.data, viewKey).not.toBeNull();
    }
    const { origin: pendingOrigin } = await start();
    const pending = createLiveAdapter("sandbox", { transport: createHttpTransport(pendingOrigin, { fetch: readerFetch }) });
    for (const viewKey of operationsReadViewKeys)
      await expect(pending.readView(request(viewKey))).rejects.toMatchObject({ category: "unavailable", body: { code: "INTEGRATION_PENDING" } });
  });

  it("serves exactly the operations view keys the frontend registry validates, and leaves shippingHub, inventory and support to their owners", async () => {
    const registered = ["operationsOverview", "orderDetail", "orderCustomer", "shippingException", "returnDetail", "fulfillmentAnalytics", "operationsShipping", "opsHealth"];
    expect([...operationsReadViewKeys].sort()).toEqual(registered.sort());
    for (const viewKey of operationsReadViewKeys) expect(viewSchemas[viewKey], viewKey).toBe(opsViewSchemas[viewKey]);
    let reads = 0;
    const { read } = await start({ operationsReadSource: async () => { reads++; return null; } });
    const shipping = await read("shippingHub", {});
    expect(shipping).toMatchObject({ status: 503, body: { code: "SHIPPING_SOURCE_UNCONFIGURED", executionCertainty: "notApplied" } });
    expect(shipping.body).not.toHaveProperty("data");
    expect(reads).toBe(0);
  });
  it.each(operationsReadViewKeys)("%s refuses a demo identity at the authenticated native boundary", async viewKey => {
    const record = { ...operationsRecord(viewKey) as object, datasetKey: "demo-only-record" };
    const { read } = await start({ operationsReadSource: async () => operationsSnapshot(viewKey, { record }) });
    const result = await read(viewKey, operationsReadTestFilters[viewKey]);
    expect(result.status).toBe(502); expect(result.body).not.toHaveProperty("data");
  });

  it.each([403, 409] as const)("rejects a source authority change (%s) before the HTTP read publishes", async status => {
    let entered!: () => void, release!: () => void, changed = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const source: OperationsReadSourceReader = {
      async read(_scope, request, options) { const captured = operationsSnapshot(request.viewKey, { principalRef: options.principal.principalRef }); entered(); await gate; return captured; },
      assertCurrent() { if (changed) throw new OperationsReadError("private-revoked-proof", status); },
    };
    const { read } = await start({ operationsReadSource: source });
    const pending = read("operationsOverview", {}); await started; changed = true; release();
    const result = await pending;
    expect(result.status).toBe(status); expect(result.body).not.toHaveProperty("data"); expect(result.text).not.toContain("private-revoked-proof");
  });

  it.each(["orderDetail", "returnDetail"] as const)("%s preserves partial and expired absence through HTTP", async viewKey => {
    let stale = false;
    const { read } = await start({ operationsReadSource: async () => operationsSnapshot(viewKey, { record: null,
      ...(stale ? { validUntil: "2026-11-06T11:59:59.000Z" } : {}),
      coverage: stale ? { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } : { state: "partial", expectedCount: null, observedCount: null, reasonCodes: ["SOURCE_DEFERRED"] } }) });
    expect((await read(viewKey, operationsReadTestFilters[viewKey])).body).toMatchObject({ dataState: "partial", data: null, coverage: { complete: false } });
    stale = true;
    expect((await read(viewKey, operationsReadTestFilters[viewKey])).body).toMatchObject({ dataState: "stale", data: null, coverage: { complete: false } });
  });

});
