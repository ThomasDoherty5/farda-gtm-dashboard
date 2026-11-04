import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError, type AdapterErrorBody } from "./errors";
import { respondWith } from "./demoViews";
import { DEMO_NOW } from "@/fixtures/overview";
import { fulfillmentDemo, heldRows, operationsDemo, orderDemo, returnDemo, shippingExceptionDemo, type OperationsOverview, type ReturnDetail, type ReturnDisposition, type ReturnResolution, type ShippingExceptionDetail } from "@/fixtures/operations";

type Capability = ReadResponse<unknown>["capabilities"][number];

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

export type ReturnProposalPayload = { returnRef: string; disposition: ReturnDisposition; resolution: ReturnResolution; reason: string };
export type ShippingDecisionPayload = { shipmentRef: string; exceptionId: string; decision: "refund" | "replacement"; reason: string };

const minutesBefore = (iso: string, minutes: number) => new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();

/**
 * Demo stand-in for the operations read models and the source-owned operations intents.
 * `scenario` is a demo-only filter that selects a labeled fixture; the live adapter never reads it.
 * Nothing here contacts Shopify, Shippo or a carrier. An accepted intent is queued for approval, not done.
 */
export function createDemoOps() {
  const decisions = new Map<string, NonNullable<ShippingExceptionDetail["decision"]>>();
  const versions = new Map<string, number>();
  const results = new Map<string, { hash: string; result: ActionResponse }>();

  const proposals = new Map<string, NonNullable<ReturnDetail["proposal"]>>();
  const exceptionKey = (shipmentRef: string, exceptionId: string) => `${shipmentRef}/${exceptionId}`;

  function overview(request: ReadRequest<{ scenario?: string }>): ReadResponse<OperationsOverview> {
    const scenario = request.filters.scenario ?? "";
    if (scenario === "unavailable") fail("SOURCE_UNAVAILABLE", "The warehouse mirror could not be reached.", request.requestId, { retryable: true });
    const base = structuredClone(operationsDemo);
    let data: OperationsOverview | null = base;
    let dataState: ReadResponse<unknown>["dataState"] = "ready";
    if (scenario === "empty") {
      data = { ...base, queue: { rows: [], total: 0 }, all: { ...base.all, toShip: { ...base.all.toShip, value: 0 }, waitingOverTwoDays: { ...base.all.waitingOverTwoDays, value: 0 } } };
      dataState = "empty";
    }
    if (scenario === "holds") data = { ...base, queue: { total: base.queue.total, rows: [...base.queue.rows, ...heldRows] } };
    if (scenario === "stale") {
      base.source.lastSyncedAt = minutesBefore(DEMO_NOW, 190);
      dataState = "stale";
    }
    if (scenario === "unknown")
      data = { ...base, all: { ...base.all, timeToShipDays: { ...base.all.timeToShipDays, state: "unknown", value: null, reasonCode: "TIMING_NOT_READ" } }, health: { ...base.health, shippingCostPerOrder: { ...base.health.shippingCostPerOrder, state: "unknown", value: null, reasonCode: "COST_NOT_READ" } } };
    const res = respondWith(request, data, { dataVersion: "operations-demo@1", dataState });
    res.sourceFreshness = [
      {
        sourceRef: { source: "sheets-warehouse", accountId: request.requestedScope.accountIds[0] ?? "demo", sourceId: null, canonicalId: null, url: null, identityState: "resolved", provenanceRef: "demo" },
        lastSourceSuccessAt: base.source.lastSyncedAt,
        observedAt: DEMO_NOW,
        mirroredAt: DEMO_NOW,
        staleReasonCode: scenario === "stale" ? "SOURCE_SYNC_DELAYED" : null,
      },
    ];
    return res;
  }

  function order(request: ReadRequest<{ orderId: string }>) {
    const data = orderDemo(request.filters.orderId) ?? fail("RECORD_NOT_FOUND", "This order does not exist or was removed.", request.requestId);
    return respondWith(request, data, { dataVersion: `order-${data.orderRef}@1`, dataState: data.mirror.state === "stale" ? "stale" : "ready" });
  }

  const exceptionCapabilities = (hasDecision: boolean): Capability[] => [
    hasDecision
      ? { actionKind: "recordShippingDecision", state: "held", reasonCodes: ["DECISION_ALREADY_RECORDED"] }
      : { actionKind: "recordShippingDecision", state: "available", reasonCodes: [] },
  ];

  function shippingException(request: ReadRequest<{ shipmentId: string; exceptionId: string; scenario?: string }>) {
    const { shipmentId, exceptionId } = request.filters;
    const base = shippingExceptionDemo(shipmentId, exceptionId) ?? fail("RECORD_NOT_FOUND", "This shipment exception does not exist or was removed.", request.requestId);
    const key = exceptionKey(shipmentId, exceptionId);
    const version = `ex${versions.get(key) ?? 1}`;
    const decision = decisions.get(key) ?? null;
    return respondWith(request, { ...base, version, decision }, { dataVersion: version, capabilities: exceptionCapabilities(Boolean(decision)) });
  }

  function returnDetail(request: ReadRequest<{ returnId: string; scenario?: string }>) {
    const base = returnDemo(request.filters.returnId, request.filters.scenario) ?? fail("RECORD_NOT_FOUND", "This return does not exist or was removed.", request.requestId);
    const proposal = proposals.get(base.returnRef) ?? null;
    const data = { ...base, proposal, version: proposal ? "ret2" : base.version };
    const caps: Capability[] =
      data.state === "resolved"
        ? []
        : [
            proposal
              ? { actionKind: "prepareReturnTask", state: "held", reasonCodes: ["PROPOSAL_ALREADY_PREPARED"] }
              : { actionKind: "prepareReturnTask", state: "available", reasonCodes: [] },
            { actionKind: "closeReturn", state: "held", reasonCodes: ["RECEIPTS_MISSING"] },
          ];
    return respondWith(request, data, { dataVersion: data.version, capabilities: caps });
  }

  function fulfillment(request: ReadRequest<{ days?: number }>) {
    if (request.filters.days !== undefined && request.filters.days !== 7 && request.filters.days !== 14) fail("VALIDATION_FAILED", "Choose 7 or 14 days.", request.requestId, { fieldErrors: { days: "Choose 7 or 14 days." } });
    const data = fulfillmentDemo(request.filters.days === 7 ? 7 : 14);
    return respondWith(request, data, { dataVersion: `fulfillment-${data.periodDays}@1`, dataState: data.periodDays === 14 ? "ready" : "partial" });
  }

  const respond = (request: ActionRequest<unknown>, state: ActionResponse["state"], over: Partial<ActionResponse> = {}): ActionResponse => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    actionRef: `demo-action-${request.idempotencyKey}`,
    state,
    runRef: null,
    approvalRef: request.approvalRef,
    manifestRef: request.manifestRef,
    payloadVersion: request.expectedVersion,
    policyVersion: "ops-demo@1",
    modelVersion: null,
    offerVersion: null,
    reasonCodes: [],
    receiptRefs: [],
    nextAction: null,
    nextPollAfterMs: null,
    ...over,
  });

  function recordShippingDecision(request: ActionRequest<ShippingDecisionPayload>): ActionResponse {
    const { shipmentRef, exceptionId, decision, reason } = request.payload;
    const base = shippingExceptionDemo(shipmentRef, exceptionId) ?? fail("RECORD_NOT_FOUND", "This shipment exception does not exist.", request.requestId);
    const key = exceptionKey(shipmentRef, exceptionId);
    if (decisions.has(key)) fail("VALIDATION_FAILED", "A decision is already recorded. A second refund or replacement is not allowed.", request.requestId);
    const current = `ex${versions.get(key) ?? 1}`;
    if (request.expectedVersion !== current) fail("STALE_VERSION", "This exception changed. Reload it before recording a decision.", request.requestId, { currentVersion: current });
    if (decision !== "refund" && decision !== "replacement") fail("VALIDATION_FAILED", "Choose refund or replacement.", request.requestId, { fieldErrors: { decision: "Choose refund or replacement." } });
    if (!reason.trim()) fail("VALIDATION_FAILED", "A reason is required.", request.requestId, { fieldErrors: { reason: "Enter the operational reason." } });
    decisions.set(key, { choice: decision, reason: reason.trim(), state: "Waiting for approval. Nothing has been refunded or shipped." });
    versions.set(key, (versions.get(key) ?? 1) + 1);
    return respond(request, "approvalPending", { reasonCodes: ["AWAITING_SOURCE_RECEIPT"], payloadVersion: `ex${versions.get(key)}`, nextAction: { kind: "sourceReceipt", ownerRef: base.owner, dueAt: null, available: false } });
  }

  function prepareReturnTask(request: ActionRequest<ReturnProposalPayload>): ActionResponse {
    const { returnRef, disposition, resolution, reason } = request.payload;
    const base = returnDemo(returnRef) ?? fail("RECORD_NOT_FOUND", "This return does not exist.", request.requestId);
    if (proposals.has(returnRef)) fail("VALIDATION_FAILED", "A proposal is already prepared for this return. A second refund or replacement is not allowed.", request.requestId);
    const current = proposals.has(returnRef) ? "ret2" : base.version;
    if (request.expectedVersion !== current) fail("STALE_VERSION", "This return changed. Reload it before preparing the task.", request.requestId, { currentVersion: current });
    if (!reason.trim()) fail("VALIDATION_FAILED", "A reason is required.", request.requestId, { fieldErrors: { reason: "Enter the operational reason." } });
    if (disposition === "restock" && !base.inspection.resellable) fail("VALIDATION_FAILED", "Restock needs an inspection that verifies the unit is resellable.", request.requestId, { fieldErrors: { disposition: "Not verified resellable. Quarantine it instead." } });
    if (resolution !== "refund" && resolution !== "replacement") fail("VALIDATION_FAILED", "Choose refund or replacement, not both.", request.requestId, { fieldErrors: { resolution: "Choose refund or replacement." } });
    const response = respond(request, "approvalPending", { reasonCodes: ["AWAITING_APPROVAL"], payloadVersion: "ret2", nextAction: { kind: "approval", ownerRef: "Fulfillment", dueAt: null, available: false } });
    proposals.set(returnRef, { state: "Prepared and waiting for approval. Nothing has been refunded, restocked or shipped.", actionRef: response.actionRef });
    return response;
  }

  return {
    read(request: ReadRequest<unknown>): ReadResponse<unknown> | null {
      switch (request.viewKey) {
        case "operationsOverview":
          return overview(request as ReadRequest<{ scenario?: string }>);
        case "orderDetail":
          return order(request as ReadRequest<{ orderId: string }>);
        case "shippingException":
          return shippingException(request as ReadRequest<{ shipmentId: string; exceptionId: string }>);
        case "returnDetail":
          return returnDetail(request as ReadRequest<{ returnId: string; scenario?: string }>);
        case "fulfillmentAnalytics":
          return fulfillment(request as ReadRequest<{ days?: number }>);
        default:
          return null;
      }
    },
    /** Same key and payload returns the original result; the same key with a changed payload is refused. */
    submit(request: ActionRequest<unknown>): ActionResponse | null {
      if (request.actionKind !== "recordShippingDecision" && request.actionKind !== "prepareReturnTask") return null;
      const hash = JSON.stringify([request.operation, request.actionKind, request.expectedVersion, request.payload]);
      const prior = results.get(request.idempotencyKey);
      if (prior) {
        if (prior.hash !== hash) fail("MANIFEST_CHANGED", "This action changed, so it needs a fresh preview.", request.requestId);
        return prior.result;
      }
      const result = request.actionKind === "prepareReturnTask" ? prepareReturnTask(request as ActionRequest<ReturnProposalPayload>) : recordShippingDecision(request as ActionRequest<ShippingDecisionPayload>);
      results.set(request.idempotencyKey, { hash, result });
      return result;
    },
  };
}
