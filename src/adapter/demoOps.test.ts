import { SCHEMA_VERSION, type ActionRequest } from "./contract";
import { createDemoOps, type ReturnProposalPayload, type ShippingDecisionPayload } from "./demoOps";
import { AdapterError } from "./errors";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;
const action = <P,>(actionKind: string, expectedVersion: string, payload: P, idempotencyKey = `k-${++seq}`): ActionRequest<P> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "requestApproval",
  requestedScope: scope,
  actionKind,
  entityRefs: [],
  expectedVersion,
  approvalRef: null,
  manifestRef: null,
  idempotencyKey,
  payload,
  requestId: `r-${seq}`,
});
const decision = (over: Partial<ShippingDecisionPayload> = {}): ShippingDecisionPayload => ({ shipmentRef: "TEST-SP-0093", exceptionId: "TEST-EVT-129", decision: "refund", reason: "Carrier confirmed lost", ...over });
const proposal = (over: Partial<ReturnProposalPayload> = {}): ReturnProposalPayload => ({ returnRef: "TEST-RET-028", disposition: "restock", resolution: "refund", reason: "Return inspected · resellable", ...over });
const read = (ops: ReturnType<typeof createDemoOps>, viewKey: string, filters: object) => ops.read({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "q" });
const errorFrom = (fn: () => unknown) => { try { fn(); } catch (e) { return e as AdapterError; } throw new Error("expected a throw"); };

describe("shipping decisions", () => {
  it("queues the choice for approval and never reports it as done", () => {
    const ops = createDemoOps();
    const res = ops.submit(action("recordShippingDecision", "ex1", decision()))!;
    expect(res.state).toBe("approvalPending");
    expect(res.receiptRefs).toEqual([]);
    expect(res.nextAction?.available).toBe(false);
  });

  it("returns the original result for a retry with the same key, and refuses a changed payload under that key", () => {
    const ops = createDemoOps();
    const first = ops.submit(action("recordShippingDecision", "ex1", decision(), "same"))!;
    expect(ops.submit(action("recordShippingDecision", "ex1", decision(), "same"))).toEqual(first);
    expect(errorFrom(() => ops.submit(action("recordShippingDecision", "ex1", decision({ reason: "Other" }), "same"))).category).toBe("conflict");
  });

  it("refuses a stale version with the current one, and a second decision", () => {
    const ops = createDemoOps();
    const stale = errorFrom(() => ops.submit(action("recordShippingDecision", "ex0", decision())));
    expect(stale.category).toBe("conflict");
    expect(stale.body.currentVersion).toBe("ex1");
    ops.submit(action("recordShippingDecision", "ex1", decision()));
    expect(errorFrom(() => ops.submit(action("recordShippingDecision", "ex2", decision({ decision: "replacement" })))).message).toMatch(/already recorded/);
  });

  it("needs a choice and a reason, and says which field", () => {
    const ops = createDemoOps();
    expect(errorFrom(() => ops.submit(action("recordShippingDecision", "ex1", decision({ reason: "  " })))).body.fieldErrors).toEqual({ reason: "Enter the operational reason." });
    expect(errorFrom(() => ops.submit(action("recordShippingDecision", "ex1", { ...decision(), decision: null as never }))).body.fieldErrors).toHaveProperty("decision");
  });

  it("leaves the exception unchanged when a request is refused", () => {
    const ops = createDemoOps();
    errorFrom(() => ops.submit(action("recordShippingDecision", "ex1", decision({ reason: "" }))));
    const res = read(ops, "shippingException", { shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-129" })!;
    expect((res.data as { decision: unknown }).decision).toBeNull();
    expect(res.capabilities[0]).toMatchObject({ actionKind: "recordShippingDecision", state: "available" });
  });
});

describe("return proposals", () => {
  it("prepares one proposal for approval, and refuses a second refund or replacement", () => {
    const ops = createDemoOps();
    expect(ops.submit(action("prepareReturnTask", "ret1", proposal()))!.state).toBe("approvalPending");
    const res = read(ops, "returnDetail", { returnId: "TEST-RET-028" })!;
    expect(res.capabilities).toContainEqual(expect.objectContaining({ actionKind: "prepareReturnTask", state: "held" }));
    expect(errorFrom(() => ops.submit(action("prepareReturnTask", "ret2", proposal({ resolution: "replacement" })))).message).toMatch(/second refund or replacement/);
  });

  it("never offers close while receipts are missing", () => {
    const res = read(createDemoOps(), "returnDetail", { returnId: "TEST-RET-028" })!;
    expect(res.capabilities).toContainEqual({ actionKind: "closeReturn", state: "held", reasonCodes: ["RECEIPTS_MISSING"] });
    const resolved = read(createDemoOps(), "returnDetail", { returnId: "TEST-RET-028", scenario: "resolved" })!;
    expect(resolved.capabilities).toEqual([]);
  });

  it("refuses a missing reason with a field error and a stale version", () => {
    const ops = createDemoOps();
    expect(errorFrom(() => ops.submit(action("prepareReturnTask", "ret1", proposal({ reason: "" })))).body.fieldErrors).toHaveProperty("reason");
    expect(errorFrom(() => ops.submit(action("prepareReturnTask", "ret9", proposal()))).category).toBe("conflict");
  });

  it("ignores actions it does not own", () => {
    expect(createDemoOps().submit(action("decideApproval", "v1", {}))).toBeNull();
  });
});

describe("reads", () => {
  it("rejects an unknown period and answers an unknown record with not found", () => {
    const ops = createDemoOps();
    expect(errorFrom(() => read(ops, "fulfillmentAnalytics", { days: 30 })).body.fieldErrors).toHaveProperty("days");
    expect(errorFrom(() => read(ops, "orderDetail", { orderId: "nope" })).category).toBe("notFound");
    expect(read(ops, "somethingElse", {})).toBeNull();
  });

  it("marks the 7-day analytics partial and the stale order mirror stale", () => {
    const ops = createDemoOps();
    expect(read(ops, "fulfillmentAnalytics", { days: 7 })!.dataState).toBe("partial");
    expect(read(ops, "orderDetail", { orderId: "TEST-SH-1031" })!.dataState).toBe("stale");
    expect(read(ops, "operationsOverview", { scenario: "stale" })!.dataState).toBe("stale");
  });
});

describe("stock transfer requests", () => {
  const transfer = (over: Partial<{ from: string; to: string; units: number; reason: string }> = {}) => ({ from: "H1", to: "H2", units: 10, reason: "Rebalance", ...over });
  const request = (payload: object, version = "inv1", key?: string) => action("requestStockTransfer", version, payload, key);

  it("queues the request for approval, and moves nothing", () => {
    const ops = createDemoOps();
    expect(ops.submit(request(transfer()))!.state).toBe("approvalPending");
    const res = read(ops, "inventoryOverview", {})!;
    const data = res.data as { rows: { home: string; onHand: number }[]; pendingRequests: unknown[]; version: string };
    expect(data.rows.map((r) => r.onHand)).toEqual([100, 28, 68]);
    expect(data.pendingRequests).toHaveLength(1);
    expect(data.version).toBe("inv2");
  });

  it("counts waiting requests against what the source home can still give", () => {
    const ops = createDemoOps();
    ops.submit(request(transfer({ units: 80 })));
    const err = errorFrom(() => ops.submit(request(transfer({ units: 7, to: "H3" }), "inv2")));
    expect(err.category).toBe("resourceHold");
    expect(err.body.fieldErrors).toEqual({ units: "Only 6 available at Home H1." });
  });

  it("refuses a duplicate request, a stale version, the same home, and bad quantities", () => {
    const ops = createDemoOps();
    ops.submit(request(transfer()));
    expect(errorFrom(() => ops.submit(request(transfer(), "inv2"))).message).toMatch(/duplicate movement/);
    expect(errorFrom(() => ops.submit(request(transfer({ units: 1 }), "inv1"))).body.currentVersion).toBe("inv2");
    expect(errorFrom(() => ops.submit(request(transfer({ to: "H1" }), "inv2"))).body.fieldErrors).toHaveProperty("to");
    for (const units of [0, -3, 2.5, Number.NaN]) expect(errorFrom(() => ops.submit(request(transfer({ units }), "inv2"))).body.fieldErrors).toHaveProperty("units");
    expect(errorFrom(() => ops.submit(request(transfer({ reason: " " }), "inv2"))).body.fieldErrors).toHaveProperty("reason");
  });

  it("returns the original answer for a retried key", () => {
    const ops = createDemoOps();
    const first = ops.submit(request(transfer(), "inv1", "same"))!;
    expect(ops.submit(request(transfer(), "inv1", "same"))).toEqual(first);
  });
});

describe("support reads", () => {
  it("answers each known case and says not found for another", () => {
    const ops = createDemoOps();
    expect(read(ops, "supportWorkspace", { caseId: "TEST-ISS-016" })!.capabilities).toEqual([{ actionKind: "reopenCase", state: "unsupported", reasonCodes: ["INTERCOM_OWNS_CASES"] }]);
    expect(errorFrom(() => read(ops, "supportWorkspace", { caseId: "x" })).category).toBe("notFound");
  });
});
