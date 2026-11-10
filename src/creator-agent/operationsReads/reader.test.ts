// @vitest-environment node
import { describe, expect, it } from "vitest";
import { operationsReadViewKeys, type OperationsReadViewKey } from "./contract";
import { createOperationsReadReader, OperationsReadError } from "./reader";
import type { OperationsReadSourceReader } from "./source";
import { operationsReadTestFilters, operationsReadTestScope, operationsReadTestTime, operationsRecord, operationsSnapshot, syntheticCustomer, syntheticAuditReason } from "./fixtures.testkit";
import { operationsTestSource } from "./fixtures.testkit";
import { opsViewSchemas } from "../../adapter/viewSchemas/ops";
import { nativeOrderRecord } from "./fixtures.testkit";

const secret = "synthetic-operations-reference-key-not-a-secret-01";
const now = () => Date.parse(operationsReadTestTime);
const reader = (source?: OperationsReadSourceReader | OperationsReadSourceReader["read"], extra: { timeoutMs?: number; clock?: () => number } = {}) =>
{
  const native = createOperationsReadReader({ scope: operationsReadTestScope, secret, source: typeof source === "function" ? operationsTestSource(source) : source, now: extra.clock ?? now, timeoutMs: extra.timeoutMs });
  return { read: (viewKey: OperationsReadViewKey, filters: unknown, role: "reader" | "reviewer", signal?: AbortSignal) =>
    native.read(viewKey, filters, { principalRef: `agent-${role}`, role }, signal) };
};
const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as OperationsReadError; } throw new Error("Expected an operations read failure"); };
const counted = { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] };

describe("operations reader", () => {
  it.each(operationsReadViewKeys)("answers %s as typed INTEGRATION_PENDING with no data when no source is configured", async viewKey => {
    const error = await failure(reader().read(viewKey, operationsReadTestFilters[viewKey], "reviewer"));
    expect(error).toBeInstanceOf(OperationsReadError);
    expect(error).toMatchObject({ code: "INTEGRATION_PENDING", status: 503, reasonCodes: ["OPERATIONS_SOURCE_UNCONFIGURED"] });
  });

  it.each(operationsReadViewKeys)("validates %s against the frontend schema and labels freshness and coverage", async viewKey => {
    const calls: unknown[] = [];
    const result = await reader(async (scope, request) => { calls.push({ scope, request }); return operationsSnapshot(viewKey); })
      .read(viewKey, operationsReadTestFilters[viewKey], "reviewer");
    expect(calls).toEqual([{ scope: operationsReadTestScope, request: { viewKey, filters: operationsReadTestFilters[viewKey] } }]);
    expect(opsViewSchemas[viewKey]!.safeParse(result.data).success).toBe(true);
    expect(result.dataState).toBe("ready");
    expect(result.coverage).toEqual({ expectedCount: 1, observedCount: 1, missingCount: 0, complete: true, reasonCodes: [] });
    expect(result.sourceFreshness[0]).toMatchObject({ lastSourceSuccessAt: "2026-11-06T11:55:00.000Z", freshnessState: "current", staleReasonCode: null,
      sourceRef: { url: null, sourceId: null, identityState: "unresolved" } });
    expect(result.sourceFreshness[0]!.sourceRef.provenanceRef).toMatch(/^source-[a-f0-9]{32}$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-operations-v1");
    expect(result.version).toMatch(/^ops1-[a-f0-9]{64}$/);
  });

  it.each(operationsReadViewKeys.filter(key => key !== "operationsOverview"))("refuses overview-only summary evidence on %s", async viewKey => {
    const summaryBasis = {
      scope: { home: "all", startAt: "2026-11-01T00:00:00.000Z", endAt: "2026-11-06T00:00:00.000Z", timezone: "UTC", basis: "requestedAt" },
      latency: { definition: "Fictional latency", denominator: 1, totalDays: 1, precision: 1, evidenceRef: "synthetic-private-latency", version: "synthetic-private-latency-v1" },
      shippingCost: { definition: "Fictional cost", denominator: 1, totalMinorUnits: 100, currency: "USD", evidenceRef: "synthetic-private-cost", version: "synthetic-private-cost-v1" },
    };
    for (const role of ["reader", "reviewer"] as const) for (const value of [null, summaryBasis]) {
      const record = { ...(operationsRecord(viewKey) as object), summaryBasis: value };
      const error = await failure(reader(async () => operationsSnapshot(viewKey, { record })).read(viewKey, operationsReadTestFilters[viewKey], role));
      expect(error).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", status: 502, reasonCodes: ["OPERATIONS_RECORD_INVALID"] });
      expect(JSON.stringify(error)).not.toContain("synthetic-private-");
    }
  });

  it("keeps unknown provenance values unknown instead of zero", async () => {
    const result = await reader(async () => operationsSnapshot("orderDetail", { record: nativeOrderRecord("TEST-SH-1044") })).read("orderDetail", { orderId: "TEST-SH-1044" }, "reader");
    expect((result.data as { total: unknown }).total).toMatchObject({ state: "unknown", value: null, reasonCode: "PAYMENT_RECEIPT_UNAVAILABLE" });
  });

  it("denies every intent to a reader and holds them for a reviewer; nothing is executable", async () => {
    for (const viewKey of ["shippingException", "returnDetail", "orderCustomer"] as const) {
      const source: OperationsReadSourceReader["read"] = async () => operationsSnapshot(viewKey);
      const asReader = await reader(source).read(viewKey, operationsReadTestFilters[viewKey], "reader");
      const asReviewer = await reader(source).read(viewKey, operationsReadTestFilters[viewKey], "reviewer");
      expect(asReader.capabilities.length).toBeGreaterThan(0);
      expect(asReader.capabilities.every(c => c.state === "denied" && c.reasonCodes.join() === "REVIEWER_REQUIRED")).toBe(true);
      expect(asReviewer.capabilities.every(c => c.state === "held" && c.reasonCodes.includes("OPERATIONS_ACTIONS_NOT_CONNECTED"))).toBe(true);
    }
  });

  it("withholds customer details and prior audit text from both coarse roles, and rejects unknown record keys", async () => {
    const record = operationsRecord("orderCustomer");
    const source: OperationsReadSourceReader["read"] = async () => operationsSnapshot("orderCustomer", { record });
    const asReader = await reader(source).read("orderCustomer", { orderId: "TEST-SH-1042" }, "reader");
    expect(asReader.data).toMatchObject({ access: { state: "denied", reason: "CUSTOMER_REVEAL_AUTHORITY_NOT_CONNECTED" }, revealed: null, audit: [] });
    const readerText = JSON.stringify(asReader);
    for (const value of [...Object.values(syntheticCustomer), syntheticAuditReason, "+1-555-0100", "1 Synthetic Way", "synthetic-private-token"]) expect(readerText).not.toContain(value);
    const asReviewer = await reader(source).read("orderCustomer", { orderId: "TEST-SH-1042" }, "reviewer");
    expect(Object.keys(asReviewer.data as object).sort()).toEqual(["access", "audit", "datasetKey", "nativeEvents", "orderRef", "provenance", "reportingScope", "revealed", "sourceLinks", "synthetic"]);
    expect(asReviewer.data).toMatchObject({ nativeEvents: [], reportingScope: null, sourceLinks: [] });
    expect(asReviewer.data).toMatchObject({ revealed: null, audit: [], access: { state: "denied" } });
    for (const value of [...Object.values(syntheticCustomer), syntheticAuditReason]) expect(JSON.stringify(asReviewer)).not.toContain(value);
    expect(await failure(reader(async () => operationsSnapshot("orderCustomer", { record: { ...record as object, sourceToken: "synthetic-private-token" } })).read("orderCustomer", { orderId: "TEST-SH-1042" }, "reviewer"))).toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    // A reveal without allowed access and an audit entry is refused by the frontend schema, so it never leaves the service.
    expect(await failure(reader(async () => operationsSnapshot("orderCustomer", { record: { ...(operationsRecord("orderCustomer") as object), audit: [] } }))
      .read("orderCustomer", { orderId: "TEST-SH-1042" }, "reviewer"))).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["OPERATIONS_RECORD_INVALID"] });
    // An audit entry for another order is another record.
    const foreignAudit = { ...(operationsRecord("orderCustomer") as Record<string, unknown>), audit: [{ id: "A", at: "2026-11-06T10:00:00.000Z", role: "operations", orderRef: "TEST-SH-1031", reason: "x" }] };
    expect(await failure(reader(async () => operationsSnapshot("orderCustomer", { record: foreignAudit })).read("orderCustomer", { orderId: "TEST-SH-1042" }, "reviewer")))
      .toMatchObject({ reasonCodes: ["OPERATIONS_RECORD_ADDRESS_MISMATCH"] });
  });

  it("rejects a strict-schema order record that carries customer data under a new key", async () => {
    const record = { ...(operationsRecord("orderDetail") as object), customerEmail: "synthetic@example.test" };
    expect(await failure(reader(async () => operationsSnapshot("orderDetail", { record })).read("orderDetail", { orderId: "TEST-SH-1042" }, "reviewer")))
      .toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["OPERATIONS_RECORD_INVALID"] });
  });

  it("reports stale and partial sources honestly and never as complete", async () => {
    const stale = await reader(async () => operationsSnapshot("operationsOverview"), { clock: () => Date.parse("2026-11-06T12:10:00.000Z") })
      .read("operationsOverview", {}, "reader");
    expect(stale).toMatchObject({ dataState: "stale", coverage: { complete: false, reasonCodes: ["OPERATIONS_SOURCE_STALE"] } });
    expect(stale.sourceFreshness[0]).toMatchObject({ staleReasonCode: "OPERATIONS_SOURCE_STALE" });
    expect(stale.data).not.toBeNull();
    // The server-owned 15-minute order ceiling wins over a longer source lease.
    const longLease = await reader(async () => operationsSnapshot("operationsOverview", { validUntil: "2026-12-30T00:00:00.000Z" }),
      { clock: () => Date.parse("2026-11-06T12:10:01.000Z") }).read("operationsOverview", {}, "reader");
    expect(longLease.dataState).toBe("stale");
    const partial = await reader(async () => operationsSnapshot("operationsShipping", { coverage: { state: "partial", expectedCount: 9, observedCount: 7, reasonCodes: ["CARRIER_SCANS_DEFERRED"] } }))
      .read("operationsShipping", {}, "reader");
    expect(partial).toMatchObject({ dataState: "partial", coverage: { expectedCount: 9, observedCount: 7, missingCount: 2, complete: false, reasonCodes: ["CARRIER_SCANS_DEFERRED"] } });
    const unknownTotal = await reader(async () => operationsSnapshot("operationsShipping", { coverage: { state: "partial", expectedCount: null, observedCount: 7, reasonCodes: ["CARRIER_UNIVERSE_UNKNOWN"] } }))
      .read("operationsShipping", {}, "reader");
    expect(unknownTotal.coverage).toMatchObject({ expectedCount: null, missingCount: null, complete: false });
    const heldStale = await reader(async () => operationsSnapshot("returnDetail"), { clock: () => Date.parse("2026-11-06T12:10:00.000Z") })
      .read("returnDetail", { returnId: "TEST-RET-028" }, "reviewer");
    expect(heldStale.capabilities.every(c => c.state === "held" && c.reasonCodes.includes("SOURCE_STALE"))).toBe(true);
  });

  it("treats an empty list as empty only when the source counted zero, and a missing detail as not found", async () => {
    const empty = await reader(async () => operationsSnapshot("opsHealth", { record: null, coverage: counted })).read("opsHealth", {}, "reader");
    expect(empty).toMatchObject({ dataState: "empty", data: null, coverage: { expectedCount: 0, complete: true } });
    expect(await failure(reader(async () => operationsSnapshot("opsHealth", { record: null })).read("opsHealth", {}, "reader")))
      .toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    for (const viewKey of ["orderDetail", "orderCustomer", "shippingException", "returnDetail"] as const)
      expect(await failure(reader(async () => operationsSnapshot(viewKey, { record: null, coverage: counted }))
        .read(viewKey, operationsReadTestFilters[viewKey], "reader")), viewKey).toMatchObject({ code: "RECORD_NOT_FOUND", status: 404 });
  });

  it("refuses foreign scope, another view, another address, another period and invalid records", async () => {
    const cases: [OperationsReadViewKey, Record<string, unknown>, string][] = [
      ["operationsOverview", { scope: { ...operationsReadTestScope, accountId: "foreign" } }, "SOURCE_AUTHORITY_DENIED"],
      ["operationsOverview", { scope: { ...operationsReadTestScope, workspaceId: "foreign" } }, "SOURCE_AUTHORITY_DENIED"],
      ["operationsOverview", { viewKey: "opsHealth" }, "SOURCE_RESPONSE_INVALID"],
      ["operationsOverview", { observedAt: "2026-11-06T13:00:00.000Z", validUntil: "2026-11-06T14:00:00.000Z" }, "SOURCE_RESPONSE_INVALID"],
      ["operationsOverview", { record: { datasetKey: "operations-demo" } }, "SOURCE_RESPONSE_INVALID"],
      ["operationsOverview", { coverage: { state: "complete", expectedCount: 2, observedCount: 1, reasonCodes: [] } }, "SOURCE_RESPONSE_INVALID"],
      ["operationsOverview", { coverage: { state: "partial", expectedCount: 2, observedCount: 1, reasonCodes: [] } }, "SOURCE_RESPONSE_INVALID"],
      ["operationsOverview", { credential: "synthetic" }, "SOURCE_RESPONSE_INVALID"],
    ];
    for (const [viewKey, patch, code] of cases)
      expect(await failure(reader(async () => operationsSnapshot(viewKey, patch)).read(viewKey, operationsReadTestFilters[viewKey], "reader")), JSON.stringify(patch)).toMatchObject({ code });
    const addresses: [OperationsReadViewKey, Record<string, string | number>][] = [
      ["orderDetail", { orderId: "TEST-SH-1031" }], ["orderCustomer", { orderId: "TEST-SH-1031" }], ["returnDetail", { returnId: "TEST-RET-029" }],
      ["shippingException", { shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-130" }], ["shippingException", { shipmentId: "TEST-SP-0091", exceptionId: "TEST-EVT-129" }],
      ["fulfillmentAnalytics", { days: 7 }],
    ];
    for (const [viewKey, filters] of addresses)
      expect(await failure(reader(async () => operationsSnapshot(viewKey)).read(viewKey, filters, "reviewer")), JSON.stringify(filters))
        .toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["OPERATIONS_RECORD_ADDRESS_MISMATCH"] });
  });

  it("refuses demo-only and unknown filters before any source access", async () => {
    let reads = 0;
    const source: OperationsReadSourceReader["read"] = async () => { reads++; return operationsSnapshot("operationsOverview"); };
    for (const filters of [{ scenario: "stale" }, { fixture: "x" }, { q: "x" }, { home: "H4" }])
      expect(await failure(reader(source).read("operationsOverview", filters, "reader"))).toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(await failure(reader(source).read("returnDetail", { returnId: "TEST-RET-028", scenario: "resolved" }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await failure(reader(source).read("fulfillmentAnalytics", { days: 30 }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await failure(reader(source).read("fulfillmentAnalytics", { days: "14" }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await failure(reader(source).read("orderDetail", { orderId: "../x" }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await failure(reader(source).read("shippingException", { shipmentId: "TEST-SP-0093" }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(reads).toBe(0);
  });

  it("maps source denial, failure, null, timeout and cancellation without leaking source text", async () => {
    const leak = "Bearer synthetic-provider-credential-should-not-leak-0001";
    expect(await failure(reader(async () => { throw new OperationsReadError(leak, 401); }).read("operationsOverview", {}, "reader")))
      .toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", status: 403 });
    const unavailable = await failure(reader(async () => { throw new Error(leak); }).read("operationsOverview", {}, "reader"));
    expect(unavailable).toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503 });
    expect(JSON.stringify({ ...unavailable, message: unavailable.message })).not.toContain("credential");
    expect(await failure(reader(async () => null).read("operationsOverview", {}, "reader"))).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    let observedSignal: AbortSignal | undefined;
    const hung: OperationsReadSourceReader["read"] = (_scope, _request, { signal }) => { observedSignal = signal; return new Promise(() => {}); };
    expect(await failure(reader(hung, { timeoutMs: 20 }).read("operationsOverview", {}, "reader"))).toMatchObject({ code: "TIMEOUT", status: 504 });
    expect(observedSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = reader(hung).read("operationsOverview", {}, "reader", controller.signal);
    controller.abort();
    expect(await failure(pending)).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not cache between reads, so a changed source or a later denial is always observed", async () => {
    let calls = 0, deny = false;
    const source: OperationsReadSourceReader["read"] = async () => { calls++; if (deny) throw new OperationsReadError("DENIED", 403); return operationsSnapshot("operationsOverview"); };
    const r = reader(source);
    await r.read("operationsOverview", {}, "reader");
    deny = true;
    expect(await failure(r.read("operationsOverview", {}, "reader"))).toMatchObject({ code: "SOURCE_AUTHORITY_DENIED" });
    expect(calls).toBe(2);
  });

  it("requires a private reference key", () => {
    expect(() => createOperationsReadReader({ scope: operationsReadTestScope, secret: "short" })).toThrow();
  });
});

