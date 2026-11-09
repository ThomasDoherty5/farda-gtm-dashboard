// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFinanceReader, FinanceError } from "./reader";
import type { FinanceSourceReader } from "./source";
import type { FinanceViewKey } from "./contract";
import { financeSnapshot, financeRecord, financeTestScope, financeTestFilters } from "./fixtures.testkit";

const principal = { principalRef: "agent-reader", role: "reader" as const };
const clock = () => Date.parse("2026-11-06T12:00:00.000Z");
const make = (source: FinanceSourceReader, now = clock) => createFinanceReader({ scope: financeTestScope, secret: "synthetic-current-source-fence-key-000000000000", source, now });
const filtersFor = (key: FinanceViewKey) => financeTestFilters[key];
const viewKey = "commissionLedger" as const;
const fixed = (patch: Record<string, unknown> = {}): FinanceSourceReader => ({ read: async () => financeSnapshot(viewKey, patch), assertCurrent() {} });

describe("finance current-authority and native boundary", () => {
  it.each(["permission", "version"] as const)("rejects %s changed while a source read is pending", async change => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let revoked = false, advanced = false;
    const source: FinanceSourceReader = {
      async read() { const captured = financeSnapshot(viewKey); entered(); await gate; return captured; },
      assertCurrent(s, binding) {
        expect(binding).toEqual({ scope: financeTestScope, principal, request: { viewKey, filters: filtersFor(viewKey) } });
        expect(s.permissionVersion).toBe("synthetic-permission-v1");
        if (revoked) throw new FinanceError("private-source-denial", 403);
        if (advanced) throw new FinanceError("private-source-revision", 409);
      },
    };
    const pending = make(source).read(viewKey, filtersFor(viewKey), principal);
    await started;
    revoked = change === "permission"; advanced = change === "version"; release();
    await expect(pending).rejects.toMatchObject({ code: revoked ? "SOURCE_AUTHORITY_DENIED" : "SOURCE_VERSION_CHANGED", status: revoked ? 403 : 409 });
  });

  it("retains a final synchronous fence for publication and freezes its captured basis", async () => {
    const answer = financeSnapshot(viewKey); let allowed = true, assertions = 0;
    const source: FinanceSourceReader = { read: async () => answer, assertCurrent(s, binding) {
      assertions++;
      expect(Object.isFrozen(s)).toBe(true); expect(Object.isFrozen(binding.request.filters)).toBe(true);
      if (!allowed) throw new FinanceError("denied", 403);
    } };
    const result = await make(source).read(viewKey, filtersFor(viewKey), principal);
    expect(assertions).toBeGreaterThanOrEqual(2);
    answer.version = "mutated-external-object";
    expect(JSON.stringify(result)).not.toContain("mutated-external-object");
    allowed = false;
    expect(() => result.assertCurrent()).toThrow("SOURCE_AUTHORITY_DENIED");
    expect(JSON.stringify(result)).not.toContain("synthetic-permission-v1");
    expect(JSON.stringify(result)).not.toContain("principalRef");
  });

  it("rejects a missing, asynchronous or non-void final assertion", async () => {
    for (const assertion of [undefined, async () => undefined, () => true]) {
      const source = { read: async () => financeSnapshot(viewKey), assertCurrent: assertion } as unknown as FinanceSourceReader;
      await expect(make(source).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_UNVERIFIED", status: 503 });
    }
  });

  it("rejects a snapshot for another principal and missing permission proof", async () => {
    await expect(make(fixed({ principalRef: "another-principal" })).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_DENIED" });
    await expect(make(fixed({ permissionVersion: undefined })).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  });

  it("accepts explicit synthetic native evidence and refuses demo identities or inconsistent evidence markers", async () => {
    const native = await make(fixed()).read(viewKey, filtersFor(viewKey), principal);
    expect(native.data).toMatchObject({ datasetKey: "finance-native", synthetic: true, provenance: { evidenceStage: "synthetic" } });
    for (const patch of [{ datasetKey: "finance-demo" }, { synthetic: false }, { provenance: undefined }]) {
      const malformed = { ...financeRecord(viewKey) as object, ...patch };
      await expect(make(fixed({ record: malformed })).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    }
  });

  it.each(["periodClose", "closePackage", "settlementDetail", "payableDetail"] as const)("%s distinguishes unread, expired and authoritative missing detail", async key => {
    const read = (patch: Record<string, unknown>) => make({ read: async () => financeSnapshot(key, patch), assertCurrent() {} }).read(key, filtersFor(key), principal);
    const partial = await read({ record: null, coverage: { state: "partial", expectedCount: null, observedCount: null, reasonCodes: ["SOURCE_DEFERRED"] } });
    expect(partial).toMatchObject({ dataState: "partial", data: null, coverage: { complete: false } });
    const stale = await read({ record: null, validUntil: "2026-11-06T11:59:59.000Z", coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } });
    expect(stale).toMatchObject({ dataState: "stale", data: null, coverage: { complete: false } });
    await expect(read({ record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } })).rejects.toMatchObject({ code: "RECORD_NOT_FOUND", status: 404 });
  });

  it("runs the final authorization fence before returning authoritative absence", async () => {
    let calls = 0;
    const key = "periodClose" as const;
    const source: FinanceSourceReader = { read: async () => financeSnapshot(key, { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } }),
      assertCurrent() { if (++calls > 1) throw new FinanceError("revoked", 403); } };
    await expect(make(source).read(key, filtersFor(key), principal)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", status: 403 });
  });
});
