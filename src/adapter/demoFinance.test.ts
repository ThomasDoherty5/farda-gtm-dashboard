import { SCHEMA_VERSION, type ActionRequest } from "./contract";
import { createDemoFinance, type ReconcilePayload } from "./demoFinance";
import { AdapterError } from "./errors";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;
const reconcile = (payload: ReconcilePayload, version = "st1", key = `k-${++seq}`): ActionRequest<ReconcilePayload> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "requestApproval",
  requestedScope: scope,
  actionKind: "reconcileSettlement",
  entityRefs: [],
  expectedVersion: version,
  approvalRef: null,
  manifestRef: null,
  idempotencyKey: key,
  payload,
  requestId: `r-${seq}`,
});
const read = (f: ReturnType<typeof createDemoFinance>, viewKey: string, filters: object) => f.read({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "q" })!;
const errorFrom = (fn: () => unknown) => { try { fn(); } catch (e) { return e as AdapterError; } throw new Error("expected a throw"); };
const ok = { settlementId: "COMM-DEMO-D", matches: [{ statementRef: "STMT-DEMO-0001", groupId: "COMM-DEMO-D" }] };

describe("finance reads", () => {
  it("reports a complete ledger as complete, and a partial one as incomplete", () => {
    const f = createDemoFinance();
    expect(read(f, "commissionLedger", {}).coverage).toMatchObject({ complete: true, expectedCount: 4, observedCount: 4 });
    const partial = read(f, "commissionLedger", { scenario: "partial" });
    expect(partial.dataState).toBe("partial");
    expect(partial.coverage).toMatchObject({ complete: false, missingCount: 1 });
  });

  it("never offers a Pay capability: payout belongs to the provider, and execution is held for approval", () => {
    const f = createDemoFinance();
    expect(read(f, "settlementDetail", { settlementId: "COMM-DEMO-D" }).capabilities).toContainEqual({ actionKind: "payCommission", state: "unsupported", reasonCodes: ["PROVIDER_OWNS_PAYOUT"] });
    expect(read(f, "payableDetail", { payableId: "PAY-0012" }).capabilities).toEqual([{ actionKind: "executePayment", state: "held", reasonCodes: ["FOUNDER_APPROVAL_PENDING"] }]);
  });

  it("answers not found for an unknown record, and null for another view", () => {
    const f = createDemoFinance();
    expect(errorFrom(() => read(f, "settlementDetail", { settlementId: "x" })).category).toBe("notFound");
    expect(errorFrom(() => read(f, "payableDetail", { payableId: "x" })).category).toBe("notFound");
    expect(f.read({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "other", requestedScope: scope, filters: {}, period: null, sort: [], page: { cursor: null, limit: 1 }, requestId: "q" })).toBeNull();
  });
});

describe("reconciliation requests", () => {
  it("queues the match for review and marks nothing reconciled", () => {
    const f = createDemoFinance();
    const res = f.submit(reconcile(ok))!;
    expect(res.state).toBe("approvalPending");
    expect(res.receiptRefs).toEqual([]);
    const after = read(f, "settlementDetail", { settlementId: "COMM-DEMO-D" });
    expect((after.data as { invoiceState: string; submitted: unknown; version: string }).invoiceState).toBe("unmatched");
    expect((after.data as { submitted: unknown }).submitted).not.toBeNull();
    expect((after.data as { version: string }).version).toBe("st2");
  });

  it("leaves a duplicate or conflicting line unresolved", () => {
    const f = createDemoFinance();
    const err = errorFrom(() => f.submit(reconcile({ settlementId: "COMM-DEMO-D", matches: [{ statementRef: "STMT-DEMO-0002", groupId: "COMM-DEMO-D" }] })));
    expect(err.body.fieldErrors).toEqual({ matches: "STMT-DEMO-0002 stays unresolved (duplicate)." });
  });

  it("refuses an empty selection, an unknown line, two lines for one group, a stale version, and a second submission", () => {
    const f = createDemoFinance();
    expect(errorFrom(() => f.submit(reconcile({ settlementId: "COMM-DEMO-D", matches: [] }))).body.fieldErrors).toHaveProperty("matches");
    expect(errorFrom(() => f.submit(reconcile({ settlementId: "COMM-DEMO-D", matches: [{ statementRef: "NOPE", groupId: "COMM-DEMO-D" }] }))).category).toBe("validation");
    expect(errorFrom(() => f.submit(reconcile(ok, "st0"))).body.currentVersion).toBe("st1");
    f.submit(reconcile(ok));
    expect(errorFrom(() => f.submit(reconcile(ok, "st2"))).message).toMatch(/already submitted/);
  });

  it("returns the original answer for a retried key, and refuses a changed payload under it", () => {
    const f = createDemoFinance();
    const first = f.submit(reconcile(ok, "st1", "same"))!;
    expect(f.submit(reconcile(ok, "st1", "same"))).toEqual(first);
    expect(errorFrom(() => f.submit(reconcile({ ...ok, matches: [] }, "st1", "same"))).category).toBe("conflict");
  });

  it("ignores actions it does not own", () => {
    expect(createDemoFinance().submit({ ...reconcile(ok), actionKind: "other" })).toBeNull();
  });
});
