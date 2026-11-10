// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFinanceReader } from "./reader";
import { financeViewKeys } from "./contract";
import { financeSnapshot, financeTestFilters, financeTestReadAccess, financeTestScope, financeTestTime } from "./fixtures.testkit";
import type { FinanceSourceReader } from "./source";
import { nativeFinanceViewSchemas } from "../../adapter/viewSchemas/finance";

const principal = { principalRef: "agent-reader", role: "reader" as const };
const start = Date.parse(financeTestTime);
const reader = (source: FinanceSourceReader, now = () => start) => createFinanceReader({
  scope: financeTestScope, secret: "synthetic-finance-read-access-key-00000000001", source, now,
});
describe("independent finance read-access grant", () => {
  it.each(financeViewKeys)("%s publishes only the qualified deadline, without refreshing accounting evidence", async key => {
    const snapshot = financeSnapshot(key);
    const result = await reader({ read: async () => snapshot, assertCurrent(s) { expect(s.readAccess).toEqual(financeTestReadAccess()); } })
      .read(key, financeTestFilters[key], principal);
    expect(result.data).toMatchObject({ readAccess: { validUntil: snapshot.readAccess.validUntil } });
    expect(result.sourceFreshness[0]?.observedAt).toBe(snapshot.observedAt);
    expect(JSON.stringify(result.data)).not.toContain('"permissionVersion"');
    expect(JSON.stringify(result.data)).not.toContain('"principalRef"');
    expect(nativeFinanceViewSchemas[key]!.safeParse({ ...(result.data as object), readAccess: undefined }).success).toBe(false);
  });
  it.each([
    undefined, null, {},
    { observedAt: financeTestTime, validUntil: new Date(start + 15 * 60_000 + 1).toISOString() },
    { observedAt: financeTestTime, validUntil: financeTestTime },
  ])("refuses a missing or invalid independently observed grant: %j", async readAccess => {
    await expect(reader({ read: async () => financeSnapshot("financeDashboard", { readAccess }), assertCurrent() {} })
      .read("financeDashboard", {}, principal)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  });
  it("refuses future access observations and exact expiry even when the accounting report is current", async () => {
    const source = (readAccess: ReturnType<typeof financeTestReadAccess>): FinanceSourceReader => ({
      read: async () => financeSnapshot("financeDashboard", { readAccess }), assertCurrent() {},
    });
    await expect(reader(source(financeTestReadAccess(start + 1))).read("financeDashboard", {}, principal))
      .rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    await expect(reader(source(financeTestReadAccess(start - 15 * 60_000))).read("financeDashboard", {}, principal))
      .rejects.toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", status: 403 });
  });
  it("rejects expiry while awaiting the source and immediately before publication", async () => {
    let now = start, release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const snapshot = financeSnapshot("financeDashboard");
    const pending = reader({ async read() { entered(); await wait; return snapshot; }, assertCurrent() {} }, () => now)
      .read("financeDashboard", {}, principal);
    await began; now += 15 * 60_000; release();
    await expect(pending).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_DENIED" });
    now = start;
    const result = await reader({ read: async () => snapshot, assertCurrent() {} }, () => now).read("financeDashboard", {}, principal);
    now += 15 * 60_000;
    expect(() => result.assertCurrent()).toThrow("SOURCE_AUTHORITY_DENIED");
  });
  it("retains stale accounting observations under a newly observed access grant, then expires that grant", async () => {
    let now = start + 2 * 24 * 60 * 60_000;
    const snapshot = financeSnapshot("financeDashboard", {}, now);
    const result = await reader({ read: async () => snapshot, assertCurrent() {} }, () => now).read("financeDashboard", {}, principal);
    expect(result.dataState).toBe("stale");
    expect(result.coverage.complete).toBe(false);
    expect(result.sourceFreshness[0]?.observedAt).toBe("2026-11-06T11:00:00.000Z");
    now += 15 * 60_000;
    expect(() => result.assertCurrent()).toThrow("SOURCE_AUTHORITY_DENIED");
  });
  it("does not cross the access deadline during the source's final synchronous assertion", async () => {
    let now = start, expire = false;
    const result = await reader({ read: async () => financeSnapshot("financeDashboard"),
      assertCurrent() { if (expire) now += 15 * 60_000; } }, () => now).read("financeDashboard", {}, principal);
    expire = true;
    expect(() => result.assertCurrent()).toThrow("SOURCE_AUTHORITY_DENIED");
  });
});
