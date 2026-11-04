import { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ActionRequest, type ReadRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { operationsDemo, type FulfillmentAnalytics, type OperationsOverview, type OrderDetail, type ReturnDetail, type ShippingExceptionDetail } from "@/fixtures/operations";
import type { InventoryOverview } from "@/fixtures/inventory";
import type { SupportWorkspace } from "@/fixtures/support";
import { fulfillmentAnalyticsSchema, inventoryOverviewSchema, operationsOverviewSchema, opsActionResponseSchema, opsActionSchemas, opsViewSchemas, orderDetailSchema, returnDetailSchema, shippingExceptionSchema, supportWorkspaceSchema } from "./ops";
import { supportCaseIds } from "@/fixtures/support";

// A parsed response document, read loosely so each negative case can overwrite one field. Its shape is checked by the schema under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;

const readRequest = (viewKey: string, filters: unknown = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey,
  requestedScope: scope,
  filters,
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: `r-${++seq}`,
});

const actionRequest = (actionKind: string, expectedVersion: string, payload: unknown): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "requestApproval",
  requestedScope: scope,
  actionKind,
  entityRefs: [],
  expectedVersion,
  approvalRef: null,
  manifestRef: null,
  idempotencyKey: `key-${++seq}`,
  payload,
  requestId: `req-${++seq}`,
});

const viewSchema = (key: string) => opsViewSchemas[key]!;
const envelope = (key: string) => readResponseSchema(viewSchema(key));

/** Reads one demo variant and asserts the whole response body, not just `data`, parses. */
async function expectParses(adapter: ReturnType<typeof createDemoAdapter>, viewKey: string, filters?: unknown) {
  const res = await adapter.readView(readRequest(viewKey, filters));
  const parsed = envelope(viewKey).safeParse(res);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 1)).toBe(true);
  expect(res.data).not.toBeNull();
  return res.data as Doc;
}

const expectError = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x as AdapterError);
  expect(e).toBeInstanceOf(AdapterError);
  expect(e!.body.code).toBe(code);
};

const clone = <T>(v: T): T => structuredClone(v);
/** A copy of the object without one key: how the "missing required field" cases are built. */
const omit = <T extends object>(value: T, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const rejects = (key: string, data: unknown) => expect(viewSchema(key).safeParse(data).success).toBe(false);

describe("the schema registry covers every operations view the demo serves", () => {
  it("has exactly these view keys", () => {
    expect(Object.keys(opsViewSchemas).sort()).toEqual(["fulfillmentAnalytics", "inventoryOverview", "operationsOverview", "operationsShipping", "orderCustomer", "orderDetail", "returnDetail", "shippingException", "supportWorkspace"]);
    expect(Object.keys(opsActionSchemas).sort()).toEqual(["prepareReturnTask", "recordShippingDecision", "requestStockTransfer"]);
  });
});

describe("operationsOverview", () => {
  it.each([undefined, "empty", "holds", "stale", "unknown"])("parses the demo response for scenario %s", async (scenario) => {
    const data = await expectParses(createDemoAdapter(), "operationsOverview", scenario ? { scenario } : {});
    if (scenario === "empty") expect(data.queue.rows).toEqual([]);
    if (scenario === "holds") expect(data.queue.rows.some((r: { hold: unknown }) => r.hold)).toBe(true);
  });

  it("keeps a known zero (the empty scenario) distinct from unknown", async () => {
    const empty = await expectParses(createDemoAdapter(), "operationsOverview", { scenario: "empty" });
    expect(empty.all.toShip).toMatchObject({ state: "known", value: 0 });
    const unknown = await expectParses(createDemoAdapter(), "operationsOverview", { scenario: "unknown" });
    expect(unknown.all.timeToShipDays).toMatchObject({ state: "unknown", value: null });
  });

  it("the unavailable scenario has no data to validate", async () => {
    await expectError(createDemoAdapter().readView(readRequest("operationsOverview", { scenario: "unavailable" })), "SOURCE_UNAVAILABLE");
  });

  describe("rejects", () => {
    const base = (): OperationsOverview => clone(operationsDemo);
    it("a missing required field", () => {
      const rest = omit(base(), "queue");
      rejects("operationsOverview", rest);
    });
    it("a wrong type", () => rejects("operationsOverview", { ...base(), needHumanResponse: "2" }));
    it("a known value that is null", () => {
      const d = base();
      d.all.toShip = { ...d.all.toShip, value: null };
      rejects("operationsOverview", d);
    });
    it("an unknown value that carries a number, so unknown can't pass as a count", () => {
      const d = base();
      d.all.toShip = { ...d.all.toShip, state: "unknown", value: 0, reasonCode: "NOT_READ" };
      rejects("operationsOverview", d);
    });
    it("an unknown value with no reason code", () => {
      const d = base();
      d.all.toShip = { ...d.all.toShip, state: "unknown", value: null, reasonCode: null };
      rejects("operationsOverview", d);
    });
    it("a plain null where a count is required, so missing never becomes zero", () => rejects("operationsOverview", { ...base(), needHumanResponse: null }));
    it.each([-1, 1.5, Number.NaN])("shipping cost with minor units %s", (minorUnits) => {
      const d = base();
      d.health.shippingCostPerOrder = { ...d.health.shippingCostPerOrder, value: { minorUnits, currency: "USD" } };
      rejects("operationsOverview", d);
    });
    it("an unknown enum value for a home, a kind and an exception state", () => {
      const d = base();
      rejects("operationsOverview", { ...d, queue: { ...d.queue, rows: [{ ...d.queue.rows[0]!, home: "H4" }] } });
      rejects("operationsOverview", { ...d, queue: { ...d.queue, rows: [{ ...d.queue.rows[0]!, kind: "gift" }] } });
      rejects("operationsOverview", { ...d, exceptions: [{ ...d.exceptions[0]!, state: "Delivered" }] });
    });
    it("a queue total smaller than the rows returned", () => {
      const d = base();
      rejects("operationsOverview", { ...d, queue: { ...d.queue, total: 1 } });
    });
    it("a percentage over 100", () => {
      const d = base();
      d.health.onTimeHandoffPct = { ...d.health.onTimeHandoffPct, value: 140 };
      rejects("operationsOverview", d);
    });
  });
});

describe("orderDetail", () => {
  it.each(["TEST-SH-1042", "TEST-SH-1031", "TEST-SC-0081"])("parses the demo response for %s", async (orderId) => {
    await expectParses(createDemoAdapter(), "orderDetail", { orderId });
  });

  it("an unknown order is a not-found error, not data", async () => {
    await expectError(createDemoAdapter().readView(readRequest("orderDetail", { orderId: "nope" })), "RECORD_NOT_FOUND");
  });

  it("keeps a sample's N/A revenue distinct from a known zero refund on an order", async () => {
    const sample = await expectParses(createDemoAdapter(), "orderDetail", { orderId: "TEST-SC-0081" });
    expect(sample.total).toMatchObject({ state: "notApplicable", value: null });
    const order = await expectParses(createDemoAdapter(), "orderDetail", { orderId: "TEST-SH-1042" });
    expect(order.refunded).toMatchObject({ state: "known", value: { minorUnits: 0 } });
  });

  describe("rejects", () => {
    const base = async () => clone(await expectParses(createDemoAdapter(), "orderDetail", { orderId: "TEST-SH-1042" }));
    it("a missing required field", async () => {
      const rest = omit(await base(), "home");
      rejects("orderDetail", rest);
    });
    it("a wrong type", async () => rejects("orderDetail", { ...(await base()), items: "one" }));
    it("negative or fractional minor units", async () => {
      const d = await base();
      rejects("orderDetail", { ...d, total: { ...d.total, value: { minorUnits: -6998, currency: "USD" } } });
      rejects("orderDetail", { ...d, total: { ...d.total, value: { minorUnits: 69.98, currency: "USD" } } });
    });
    it("an unknown enum value (milestone state, notice tone, mirror state)", async () => {
      const d = await base();
      rejects("orderDetail", { ...d, milestones: [{ ...d.milestones[0], state: "shipped" }] });
      rejects("orderDetail", { ...d, notice: { ...d.notice, tone: "info" } });
      rejects("orderDetail", { ...d, mirror: { ...d.mirror, state: "fresh" } });
    });
    it("customer details under any key, because the view mirrors no customer data", async () => {
      const d = await base();
      rejects("orderDetail", { ...d, customer: { name: "A", email: "a@example.test" } });
      rejects("orderDetail", { ...d, email: "a@example.test" });
    });
    it("a sample with a known revenue figure", async () => {
      const d = await expectParses(createDemoAdapter(), "orderDetail", { orderId: "TEST-SC-0081" });
      rejects("orderDetail", { ...clone(d), total: clone((await base()).total) });
    });
    it("an item with zero units", async () => {
      const d = await base();
      rejects("orderDetail", { ...d, items: [{ ...d.items[0], units: 0 }] });
    });
  });
});

describe("shippingException", () => {
  const filters = { shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-129" };
  const decisionPayload = { shipmentRef: "TEST-SP-0093", exceptionId: "TEST-EVT-129", decision: "refund", reason: "Carrier reported it lost" };

  it("parses the open exception and the same exception after a decision is queued", async () => {
    const adapter = createDemoAdapter();
    const open = await expectParses(adapter, "shippingException", filters);
    expect(open.decision).toBeNull();
    await adapter.submitAction(actionRequest("recordShippingDecision", open.version, decisionPayload));
    const decided = await expectParses(adapter, "shippingException", filters);
    expect(decided.decision).toMatchObject({ choice: "refund" });
    expect(decided.version).not.toBe(open.version);
  });

  it("an unknown exception is a not-found error", async () => {
    await expectError(createDemoAdapter().readView(readRequest("shippingException", { shipmentId: "x", exceptionId: "y" })), "RECORD_NOT_FOUND");
  });

  describe("rejects", () => {
    const base = async () => clone(await expectParses(createDemoAdapter(), "shippingException", filters));
    it("a missing required field", async () => {
      const rest = omit(await base(), "version");
      rejects("shippingException", rest);
    });
    it("a wrong type", async () => rejects("shippingException", { ...(await base()), events: {} }));
    it("a shipping cost that is a negative or fractional amount", async () => {
      const d = await base();
      rejects("shippingException", { ...d, shippingCost: { ...d.shippingCost, value: { minorUnits: -675, currency: "USD" } } });
      rejects("shippingException", { ...d, shippingCost: { ...d.shippingCost, value: { minorUnits: 6.75, currency: "USD" } } });
    });
    it("a known cost that is null (an unread label cost can't be a known value)", async () => {
      const d = await base();
      rejects("shippingException", { ...d, shippingCost: { ...d.shippingCost, value: null } });
    });
    it("an unknown carrier state or decision choice", async () => {
      const d = await base();
      rejects("shippingException", { ...d, carrierState: "Delivered" });
      rejects("shippingException", { ...d, decision: { choice: "both", reason: "x", state: "y" } });
    });
  });
});

describe("inventoryOverview", () => {
  it.each([undefined, "stale", "delayed", "conflict", "unread"])("parses the demo response for scenario %s", async (scenario) => {
    await expectParses(createDemoAdapter(), "inventoryOverview", scenario ? { scenario } : {});
  });

  it("the unavailable scenario has no data to validate", async () => {
    await expectError(createDemoAdapter().readView(readRequest("inventoryOverview", { scenario: "unavailable" })), "SOURCE_UNAVAILABLE");
  });

  it("parses after a transfer request is queued", async () => {
    const adapter = createDemoAdapter();
    const before = await expectParses(adapter, "inventoryOverview");
    await adapter.submitAction(actionRequest("requestStockTransfer", before.version, { from: "H1", to: "H3", units: 5, reason: "Rebalance" }));
    const after = await expectParses(adapter, "inventoryOverview");
    expect(after.pendingRequests).toHaveLength(1);
  });

  it("keeps an unread Shopify count unknown, and an unread received count unknown, not zero", async () => {
    const unread = await expectParses(createDemoAdapter(), "inventoryOverview", { scenario: "unread" });
    expect(unread.rows.find((r: { home: string }) => r.home === "H3").shopifyObserved).toMatchObject({ state: "unknown", value: null });
    expect(unread.transfer.receivedUnits).toMatchObject({ state: "unknown", value: null });
  });

  describe("rejects", () => {
    const base = async () => clone(await expectParses(createDemoAdapter(), "inventoryOverview"));
    it("a missing required field", async () => {
      const rest = omit(await base(), "rows");
      rejects("inventoryOverview", rest);
    });
    it("a wrong type", async () => {
      const d = await base();
      rejects("inventoryOverview", { ...d, rows: [{ ...d.rows[0], onHand: "100" }] });
    });
    it("a negative or fractional stock count", async () => {
      const d = await base();
      rejects("inventoryOverview", { ...d, rows: [{ ...d.rows[0], onHand: -1 }] });
      rejects("inventoryOverview", { ...d, rows: [{ ...d.rows[0], reserved: 1.5 }] });
    });
    it("a null on-hand count (missing data must not become zero)", async () => {
      const d = await base();
      rejects("inventoryOverview", { ...d, rows: [{ ...d.rows[0], onHand: null }] });
    });
    it("an unknown enum value (home, movement field, transfer stage)", async () => {
      const d = await base();
      rejects("inventoryOverview", { ...d, rows: [{ ...d.rows[0], home: "H9" }] });
      rejects("inventoryOverview", { ...d, movements: [{ ...d.movements[0], effect: { field: "reserved", delta: 1 } }] });
      rejects("inventoryOverview", { ...d, transfer: { ...d.transfer, stage: "lost" } });
    });
    it("a transfer marked received while its received count is unknown", async () => {
      const d = await base();
      rejects("inventoryOverview", { ...d, transfer: { ...d.transfer, stage: "received" } });
    });
    it("a non-integer movement delta", async () => {
      const d = await base();
      rejects("inventoryOverview", { ...d, movements: [{ ...d.movements[0], effect: { field: "onHand", delta: 0.5 } }] });
    });
  });
});

describe("supportWorkspace", () => {
  const combos = supportCaseIds.flatMap((caseId) => [undefined, "stale"].map((scenario) => [caseId, scenario] as const));
  it.each(combos)("parses the demo response for case %s, scenario %s", async (caseId, scenario) => {
    await expectParses(createDemoAdapter(), "supportWorkspace", scenario ? { caseId, scenario } : { caseId });
  });

  it("an unknown case is a not-found error", async () => {
    await expectError(createDemoAdapter().readView(readRequest("supportWorkspace", { caseId: "nope" })), "RECORD_NOT_FOUND");
  });

  describe("rejects", () => {
    const base = async () => clone(await expectParses(createDemoAdapter(), "supportWorkspace", { caseId: "TEST-ISS-021" }));
    it("a missing required field", async () => {
      const rest = omit(await base(), "cohort");
      rejects("supportWorkspace", rest);
    });
    it("a wrong type", async () => rejects("supportWorkspace", { ...(await base()), allTimeOpen: 7 }));
    it("a negative or fractional money amount", async () => {
      const d = await base();
      rejects("supportWorkspace", { ...d, fin: { ...d.fin, cost: { minorUnits: -4800, currency: "USD" } } });
      rejects("supportWorkspace", { ...d, outcomes: { ...d.outcomes, refundedAmount: { minorUnits: 104.97, currency: "USD" } } });
    });
    it("an unknown case state", async () => {
      const d = await base();
      rejects("supportWorkspace", { ...d, case: { ...d.case, state: "Closed" } });
    });
    it("a case that can be reopened but isn't resolved", async () => {
      const d = await base();
      rejects("supportWorkspace", { ...d, case: { ...d.case, canReopen: true } });
    });
    it("conversation text or customer contact under any key", async () => {
      const d = await base();
      rejects("supportWorkspace", { ...d, case: { ...d.case, transcript: "hello" } });
      rejects("supportWorkspace", { ...d, queue: [{ ...d.queue[0], customerEmail: "a@example.test" }] });
      rejects("supportWorkspace", { ...d, customer: "A" });
    });
    it("a cohort window that isn't 14 days", async () => {
      const d = await base();
      rejects("supportWorkspace", { ...d, cohort: { ...d.cohort, days: 30 } });
    });
  });
});

describe("returnDetail", () => {
  const filters = { returnId: "TEST-RET-028" };
  const proposal = { returnRef: "TEST-RET-028", disposition: "restock", resolution: "refund", reason: "Return inspected · resellable" };

  it.each([undefined, "resolved"])("parses the demo response for scenario %s", async (scenario) => {
    const data = await expectParses(createDemoAdapter(), "returnDetail", scenario ? { ...filters, scenario } : filters);
    expect(data.state).toBe(scenario === "resolved" ? "resolved" : "active");
  });

  it("parses after a return task is prepared", async () => {
    const adapter = createDemoAdapter();
    const before = await expectParses(adapter, "returnDetail", filters);
    await adapter.submitAction(actionRequest("prepareReturnTask", before.version, proposal));
    const after = await expectParses(adapter, "returnDetail", filters);
    expect(after.proposal).not.toBeNull();
  });

  it("an unknown return is a not-found error", async () => {
    await expectError(createDemoAdapter().readView(readRequest("returnDetail", { returnId: "nope" })), "RECORD_NOT_FOUND");
  });

  describe("rejects", () => {
    const base = async (scenario?: string) => clone(await expectParses(createDemoAdapter(), "returnDetail", scenario ? { ...filters, scenario } : filters));
    it("a missing required field", async () => {
      const rest = omit(await base(), "inspection");
      rejects("returnDetail", rest);
    });
    it("a wrong type", async () => rejects("returnDetail", { ...(await base()), units: "1" }));
    it("negative or fractional refund minor units", async () => {
      const d = await base();
      rejects("returnDetail", { ...d, refundAmount: { minorUnits: -3499, currency: "USD" } });
      rejects("returnDetail", { ...d, refundAmount: { minorUnits: 34.99, currency: "USD" } });
    });
    it("an unknown enum value (state, disposition, resolution)", async () => {
      const d = await base();
      rejects("returnDetail", { ...d, state: "closed" });
      rejects("returnDetail", { ...d, selected: { ...d.selected, disposition: "scrap" } });
      rejects("returnDetail", { ...d, selected: { ...d.selected, resolution: "credit" } });
    });
    it("a resolved return with no receipt chain, and an active return that has one", async () => {
      const resolved = await base("resolved");
      rejects("returnDetail", { ...resolved, resolved: null });
      rejects("returnDetail", { ...(await base()), resolved: resolved.resolved });
    });
    it("a restock selected when the inspection isn't verified resellable", async () => {
      const d = await base();
      rejects("returnDetail", { ...d, inspection: { ...d.inspection, resellable: false } });
    });
    it("a resolved return whose chain has an empty receipt", async () => {
      const d = await base("resolved");
      rejects("returnDetail", { ...d, resolved: { ...d.resolved, chain: [{ ...d.resolved.chain[0], receipt: "" }] } });
    });
  });
});

describe("fulfillmentAnalytics", () => {
  it.each([undefined, 7, 14])("parses the demo response for days %s", async (days) => {
    const data = await expectParses(createDemoAdapter(), "fulfillmentAnalytics", days === undefined ? {} : { days });
    expect(data.periodDays).toBe(days ?? 14);
  });

  it("keeps the 7-day prior period unknown and its missing transit split null, never zero", async () => {
    const data = await expectParses(createDemoAdapter(), "fulfillmentAnalytics", { days: 7 });
    expect(data.shippedPrior).toMatchObject({ state: "unknown", value: null });
    expect(data.transit).toBeNull();
  });

  it("a bad period is a validation error, not data", async () => {
    await expectError(createDemoAdapter().readView(readRequest("fulfillmentAnalytics", { days: 30 })), "VALIDATION_FAILED");
  });

  describe("rejects", () => {
    const base = async () => clone(await expectParses(createDemoAdapter(), "fulfillmentAnalytics", { days: 14 }));
    it("a missing required field", async () => {
      const rest = omit(await base(), "daily");
      rejects("fulfillmentAnalytics", rest);
    });
    it("a wrong type", async () => rejects("fulfillmentAnalytics", { ...(await base()), overdue: "4" }));
    it("a period that isn't 7 or 14", async () => rejects("fulfillmentAnalytics", { ...(await base()), periodDays: 30 }));
    it("a null daily count, so a missing day can't be a zero", async () => {
      const d = await base();
      rejects("fulfillmentAnalytics", { ...d, daily: [{ ...d.daily[0], shipped: null }] });
    });
    it("a negative or fractional count", async () => {
      const d = await base();
      rejects("fulfillmentAnalytics", { ...d, daily: [{ ...d.daily[0], backlog: -1 }] });
      rejects("fulfillmentAnalytics", { ...d, overdue: 1.5 });
    });
    it("an unknown home in the stock rows", async () => {
      const d = await base();
      rejects("fulfillmentAnalytics", { ...d, stock: [{ ...d.stock[0], home: "H7" }] });
    });
    it("a known prior period with a null value", async () => {
      const d = await base();
      rejects("fulfillmentAnalytics", { ...d, shippedPrior: { ...d.shippedPrior, value: null } });
    });
  });
});

describe("action payloads and responses", () => {
  const payloads = {
    recordShippingDecision: { shipmentRef: "TEST-SP-0093", exceptionId: "TEST-EVT-129", decision: "replacement", reason: "Carrier reported it lost" },
    prepareReturnTask: { returnRef: "TEST-RET-028", disposition: "restock", resolution: "refund", reason: "Return inspected · resellable" },
    requestStockTransfer: { from: "H1", to: "H3", units: 5, reason: "Rebalance" },
  } as const;
  const versions = { recordShippingDecision: "ex1", prepareReturnTask: "ret1", requestStockTransfer: "inv1" } as const;

  it.each(Object.keys(payloads) as (keyof typeof payloads)[])("%s: the demo accepts a payload the schema accepts, and its response is a queued request", async (kind) => {
    expect(opsActionSchemas[kind]!.payload.safeParse(payloads[kind]).success).toBe(true);
    const adapter = createDemoAdapter();
    const response = await adapter.submitAction(actionRequest(kind, versions[kind], payloads[kind]));
    const parsed = opsActionResponseSchema.safeParse(response);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(response.state).toBe("approvalPending");
    expect(response.receiptRefs).toEqual([]);
  });

  it("the same payload through the whole ActionRequest keeps the payload valid", () => {
    for (const kind of Object.keys(payloads) as (keyof typeof payloads)[]) {
      const request = actionRequest(kind, versions[kind], payloads[kind]);
      expect(opsActionSchemas[kind]!.payload.safeParse(request.payload).success).toBe(true);
    }
  });

  describe("rejects", () => {
    const bad = (kind: keyof typeof payloads, over: Record<string, unknown>) => expect(opsActionSchemas[kind]!.payload.safeParse({ ...payloads[kind], ...over }).success).toBe(false);
    it("a missing required field", () => {
      const rest = omit(payloads.recordShippingDecision, "reason");
      expect(opsActionSchemas.recordShippingDecision!.payload.safeParse(rest).success).toBe(false);
    });
    it("a blank reason", () => {
      bad("recordShippingDecision", { reason: "   " });
      bad("prepareReturnTask", { reason: "" });
      bad("requestStockTransfer", { reason: " " });
    });
    it("a wrong type", () => {
      bad("requestStockTransfer", { units: "5" });
      bad("recordShippingDecision", { shipmentRef: 93 });
    });
    it("zero, negative or non-integer units", () => {
      for (const units of [0, -5, 2.5]) bad("requestStockTransfer", { units });
    });
    it("an unknown enum value", () => {
      bad("recordShippingDecision", { decision: "both" });
      bad("prepareReturnTask", { disposition: "scrap" });
      bad("prepareReturnTask", { resolution: "refund and replacement" });
      bad("requestStockTransfer", { from: "H4" });
    });
    it("a transfer to its own source home", () => bad("requestStockTransfer", { to: "H1" }));
    it("an extra key nobody approved", () => {
      bad("recordShippingDecision", { amount: { minorUnits: 100, currency: "USD" } });
      bad("requestStockTransfer", { sku: "OTHER" });
    });
    it("a queued ops intent that reports success, with or without a receipt", async () => {
      const response = await createDemoAdapter().submitAction(actionRequest("requestStockTransfer", "inv1", payloads.requestStockTransfer));
      expect(opsActionResponseSchema.safeParse({ ...response, state: "succeeded" }).success).toBe(false);
      expect(opsActionResponseSchema.safeParse({ ...response, state: "succeeded", receiptRefs: ["r1"] }).success).toBe(false);
    });
    it("a response with the wrong shape", async () => {
      const response = await createDemoAdapter().submitAction(actionRequest("requestStockTransfer", "inv1", payloads.requestStockTransfer));
      const missing = omit(response, "actionRef");
      expect(opsActionResponseSchema.safeParse(missing).success).toBe(false);
      expect(opsActionResponseSchema.safeParse({ ...response, state: "approved" }).success).toBe(false);
      expect(opsActionResponseSchema.safeParse({ ...response, receiptRefs: "none" }).success).toBe(false);
    });
  });
});

// Compile-time check: every fixture type is accepted by the schema's inferred type, so a schema can't be narrower than the types the screens read.
const _accepts = [
  {} as OperationsOverview satisfies z.infer<typeof operationsOverviewSchema>,
  {} as OrderDetail satisfies z.infer<typeof orderDetailSchema>,
  {} as ShippingExceptionDetail satisfies z.infer<typeof shippingExceptionSchema>,
  {} as ReturnDetail satisfies z.infer<typeof returnDetailSchema>,
  {} as FulfillmentAnalytics satisfies z.infer<typeof fulfillmentAnalyticsSchema>,
  {} as InventoryOverview satisfies z.infer<typeof inventoryOverviewSchema>,
  {} as SupportWorkspace satisfies z.infer<typeof supportWorkspaceSchema>,
];
void _accepts;

describe("operationsShipping and orderCustomer (additions)", () => {
  it("parses the shipping view, and refuses an unknown carrier state", async () => {
    const data = await expectParses(createDemoAdapter(), "operationsShipping");
    const bad = clone(data);
    bad.shipments[0].carrierState = "teleported";
    rejects("operationsShipping", bad);
  });

  it("parses the customer view for a denied role and an allowed role, and never accepts details without an audited reveal", async () => {
    const denied = await expectParses(createDemoAdapter(), "orderCustomer", { orderId: "TEST-SH-1042" });
    expect(denied.revealed).toBeNull();
    const allowed = await expectParses(createDemoAdapter({ actorRole: "operations" }), "orderCustomer", { orderId: "TEST-SH-1042" });
    expect(allowed.access.state).toBe("allowed");
    const leaked = clone(denied);
    leaked.revealed = { name: "x", email: "x@example.test", city: "y" };
    rejects("orderCustomer", leaked);
  });
});
