// @vitest-environment node
import { describe, expect, it } from "vitest";
import { financeViewKeys, type FinanceViewKey } from "./contract";
import { createFinanceReader, FinanceError } from "./reader";
import type { FinanceSourceReader } from "./source";
import { financeTestSource, financeSnapshot, financeTestFilters, financeTestScope, financeTestTime } from "./fixtures.testkit";
import { financeViewSchemas } from "../../adapter/viewSchemas/finance";

const secret = "synthetic-finance-reference-key-not-a-secret-0001";
const now = () => Date.parse(financeTestTime);
const reader = (source?: FinanceSourceReader | FinanceSourceReader["read"], extra: { timeoutMs?: number; clock?: () => number } = {}) =>
{
  const native = createFinanceReader({ scope: financeTestScope, secret, source: typeof source === "function" ? financeTestSource(source) : source, now: extra.clock ?? now, timeoutMs: extra.timeoutMs });
  return { read: (viewKey: FinanceViewKey, filters: unknown, role: "reader" | "reviewer", signal?: AbortSignal) =>
    native.read(viewKey, filters, { principalRef: `agent-${role}`, role }, signal) };
};
const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as FinanceError; } throw new Error("Expected a finance failure"); };

describe("finance reader", () => {
  it.each(financeViewKeys)("answers %s as typed INTEGRATION_PENDING with no data when no source is configured", async viewKey => {
    const error = await failure(reader().read(viewKey, financeTestFilters[viewKey], "reviewer"));
    expect(error).toBeInstanceOf(FinanceError);
    expect(error).toMatchObject({ code: "INTEGRATION_PENDING", status: 503, reasonCodes: ["FINANCE_SOURCE_UNCONFIGURED"] });
  });

  it.each(financeViewKeys)("validates %s against the frontend schema and labels freshness, coverage and currency", async viewKey => {
    const calls: unknown[] = [];
    const result = await reader(async (scope, request) => { calls.push({ scope, request }); return financeSnapshot(viewKey); })
      .read(viewKey, financeTestFilters[viewKey], "reviewer");
    expect(calls).toEqual([{ scope: financeTestScope, request: { viewKey, filters: financeTestFilters[viewKey] } }]);
    expect(financeViewSchemas[viewKey]!.safeParse(result.data).success).toBe(true);
    expect(result.dataState).toBe("ready");
    expect(result.coverage).toEqual({ expectedCount: 1, observedCount: 1, missingCount: 0, complete: true, reasonCodes: [] });
    expect(result.sourceFreshness[0]).toMatchObject({ lastSourceSuccessAt: "2026-11-06T11:00:00.000Z", freshnessState: "current", staleReasonCode: null,
      sourceRef: { url: null, sourceId: null, identityState: "unresolved" } });
    expect(result.sourceFreshness[0]!.sourceRef.provenanceRef).toMatch(/^source-[a-f0-9]{32}$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-finance-v1");
    expect(result.version).toMatch(/^fin1-[a-f0-9]{64}$/);
  });

  it("keeps unknown provenance values unknown instead of zero", async () => {
    const result = await reader(async () => financeSnapshot("financeDashboard")).read("financeDashboard", {}, "reader");
    expect((result.data as { pnl: { ytd: unknown } }).pnl.ytd).toMatchObject({ state: "unknown", value: null, reasonCode: "YTD_REPORT_NOT_RECEIVED" });
  });

  it("denies every intent to a reader and holds them for a reviewer; nothing is executable", async () => {
    for (const viewKey of ["settlementDetail", "payableDetail", "periodClose", "closePackage"] as const) {
      const source: FinanceSourceReader["read"] = async () => financeSnapshot(viewKey);
      const asReader = await reader(source).read(viewKey, financeTestFilters[viewKey], "reader");
      const asReviewer = await reader(source).read(viewKey, financeTestFilters[viewKey], "reviewer");
      expect(asReader.capabilities.length).toBeGreaterThan(0);
      expect(asReader.capabilities.every(c => c.state === "denied" && c.reasonCodes.join() === "REVIEWER_REQUIRED")).toBe(true);
      expect(asReviewer.capabilities.some(c => c.state === "available")).toBe(false);
    }
  });

  it("reports stale and partial sources honestly and never as complete", async () => {
    const stale = await reader(async () => financeSnapshot("commissionLedger"), { clock: () => Date.parse("2026-11-07T11:00:00.000Z") })
      .read("commissionLedger", {}, "reader");
    expect(stale).toMatchObject({ dataState: "stale", coverage: { complete: false, reasonCodes: ["FINANCE_SOURCE_STALE"] } });
    expect(stale.sourceFreshness[0]).toMatchObject({ staleReasonCode: "FINANCE_SOURCE_STALE" });
    // The server-owned 24h ceiling wins over a longer source lease.
    const longLease = await reader(async () => financeSnapshot("commissionLedger", { validUntil: "2026-12-30T00:00:00.000Z" }),
      { clock: () => Date.parse("2026-11-07T11:00:01.000Z") }).read("commissionLedger", {}, "reader");
    expect(longLease.dataState).toBe("stale");
    const partial = await reader(async () => financeSnapshot("commissionLedger", { coverage: { state: "partial", expectedCount: 4, observedCount: 3, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } }))
      .read("commissionLedger", {}, "reader");
    expect(partial).toMatchObject({ dataState: "partial", coverage: { expectedCount: 4, observedCount: 3, missingCount: 1, complete: false, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } });
    const unknownTotal = await reader(async () => financeSnapshot("commissionLedger", { coverage: { state: "partial", expectedCount: null, observedCount: 3, reasonCodes: ["PROVIDER_UNIVERSE_UNKNOWN"] } }))
      .read("commissionLedger", {}, "reader");
    expect(unknownTotal.coverage).toMatchObject({ expectedCount: null, missingCount: null, complete: false });
  });

  it("treats an empty list as empty only when the source counted zero, and a missing detail as not found", async () => {
    const empty = await reader(async () => financeSnapshot("monthsHistory", { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } }))
      .read("monthsHistory", {}, "reader");
    expect(empty).toMatchObject({ dataState: "empty", data: null, coverage: { expectedCount: 0, complete: true } });
    expect(await failure(reader(async () => financeSnapshot("monthsHistory", { record: null })).read("monthsHistory", {}, "reader")))
      .toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    expect(await failure(reader(async () => financeSnapshot("payableDetail", { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } }))
      .read("payableDetail", { payableId: "PAY-0012" }, "reader"))).toMatchObject({ code: "RECORD_NOT_FOUND", status: 404 });
  });

  it("refuses foreign scope, another view, another address, another period and invalid records", async () => {
    const cases: [FinanceViewKey, Record<string, unknown>, string][] = [
      ["commissionLedger", { scope: { ...financeTestScope, accountId: "foreign" } }, "SOURCE_AUTHORITY_DENIED"],
      ["commissionLedger", { viewKey: "financeDashboard" }, "SOURCE_RESPONSE_INVALID"],
      ["periodClose", { period: "2026-09" }, "SOURCE_RESPONSE_INVALID"],
      ["commissionLedger", { observedAt: "2026-11-06T13:00:00.000Z" }, "SOURCE_RESPONSE_INVALID"],
      ["commissionLedger", { currency: "EUR" }, "SOURCE_RESPONSE_INVALID"],
      ["commissionLedger", { record: { datasetKey: "finance-demo" } }, "SOURCE_RESPONSE_INVALID"],
      ["commissionLedger", { coverage: { state: "complete", expectedCount: 2, observedCount: 1, reasonCodes: [] } }, "SOURCE_RESPONSE_INVALID"],
      ["commissionLedger", { coverage: { state: "partial", expectedCount: 2, observedCount: 1, reasonCodes: [] } }, "SOURCE_RESPONSE_INVALID"],
    ];
    for (const [viewKey, patch, code] of cases)
      expect(await failure(reader(async () => financeSnapshot(viewKey, patch)).read(viewKey, financeTestFilters[viewKey], "reader")), JSON.stringify(patch)).toMatchObject({ code });
    const other = financeSnapshot("settlementDetail");
    expect(await failure(reader(async () => other).read("settlementDetail", { settlementId: "TT-NATIVE-DEMO" }, "reader")))
      .toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["FINANCE_RECORD_ADDRESS_MISMATCH"] });
  });

  it("refuses demo-only and unknown filters before any source access", async () => {
    let reads = 0;
    const source: FinanceSourceReader["read"] = async () => { reads++; return financeSnapshot("commissionLedger"); };
    for (const filters of [{ scenario: "partial" }, { fixture: "x" }, { q: "x" }])
      expect(await failure(reader(source).read("commissionLedger", filters, "reader"))).toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(await failure(reader(source).read("periodClose", { period: "2026-13" }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await failure(reader(source).read("settlementDetail", { settlementId: "../x" }, "reader"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(reads).toBe(0);
  });

  it("maps source denial, failure, null, timeout and cancellation without leaking source text", async () => {
    const leak = "Bearer synthetic-provider-credential-should-not-leak-0001";
    expect(await failure(reader(async () => { throw new FinanceError(leak, 401); }).read("commissionLedger", {}, "reader")))
      .toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", status: 403 });
    const unavailable = await failure(reader(async () => { throw new Error(leak); }).read("commissionLedger", {}, "reader"));
    expect(unavailable).toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503 });
    expect(JSON.stringify({ ...unavailable, message: unavailable.message })).not.toContain("credential");
    expect(await failure(reader(async () => null).read("commissionLedger", {}, "reader"))).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    let observedSignal: AbortSignal | undefined;
    const hung: FinanceSourceReader["read"] = (_scope, _request, { signal }) => { observedSignal = signal; return new Promise(() => {}); };
    expect(await failure(reader(hung, { timeoutMs: 20 }).read("commissionLedger", {}, "reader"))).toMatchObject({ code: "TIMEOUT", status: 504 });
    expect(observedSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = reader(hung).read("commissionLedger", {}, "reader", controller.signal);
    controller.abort();
    expect(await failure(pending)).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not cache between reads, so a changed source or a later denial is always observed", async () => {
    let calls = 0, deny = false;
    const source: FinanceSourceReader["read"] = async () => { calls++; if (deny) throw new FinanceError("DENIED", 403); return financeSnapshot("commissionLedger"); };
    const r = reader(source);
    await r.read("commissionLedger", {}, "reader");
    deny = true;
    expect(await failure(r.read("commissionLedger", {}, "reader"))).toMatchObject({ code: "SOURCE_AUTHORITY_DENIED" });
    expect(calls).toBe(2);
  });

  it("requires a private reference key", () => {
    expect(() => createFinanceReader({ scope: financeTestScope, secret: "short" })).toThrow();
  });
});
