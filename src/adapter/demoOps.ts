import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError, type AdapterErrorBody } from "./errors";
import { opsExceptionsDemo, sandboxChain, shipmentsDemo } from "@/fixtures/opsShipping";
import { respondWith } from "./demoViews";
import { DEMO_NOW } from "@/fixtures/overview";
import { availableOf, inventoryDemo, type TransferRequest } from "@/fixtures/inventory";
import { HOMES, type Home } from "@/fixtures/operations";
import { supportDemo } from "@/fixtures/support";
import { buildOpsHealth } from "./opsHealth";
import { fulfillmentDemo, heldRows, operationsDemo, orderDemo, returnDemo, shippingExceptionDemo, type OperationsOverview, type ReturnDetail, type ReturnDisposition, type ReturnResolution, type ShippingExceptionDetail } from "@/fixtures/operations";

type Capability = ReadResponse<unknown>["capabilities"][number];

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

export type ReturnProposalPayload = { returnRef: string; disposition: ReturnDisposition; resolution: ReturnResolution; reason: string };
export type TransferRequestPayload = { from: Home; to: Home; units: number; reason: string };
export type ShippingDecisionPayload = { shipmentRef: string; exceptionId: string; decision: "refund" | "replacement"; reason: string };

const minutesBefore = (iso: string, minutes: number) => new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();

/**
 * Demo stand-in for the operations read models and the source-owned operations intents.
 * `scenario` is a demo-only filter that selects a labeled fixture; the live adapter never reads it.
 * Nothing here contacts Shopify, Shippo or a carrier. An accepted intent is queued for approval, not done.
 */
/** Roles that may see a customer's details. Anyone else is shown the reason. The check lives here because a hidden button is not authorization. */
export const CUSTOMER_ROLES = ["operations", "founder"] as const;
export type CustomerAuditEntry = { id: string; at: string; role: string; orderRef: string; reason: string };
export type OrderCustomerData = {
  datasetKey: "operations-customer-demo";
  orderRef: string;
  access: { state: "allowed" | "denied"; reason: string | null };
  /** Synthetic placeholders. Present only after an authorized, audited reveal. */
  revealed: { name: string; email: string; city: string } | null;
  audit: CustomerAuditEntry[];
};

export function createDemoOps(opts: { actorRole?: string } = {}) {
  const actorRole = opts.actorRole ?? "reviewer";
  const customerAudit: CustomerAuditEntry[] = [];
  const decisions = new Map<string, NonNullable<ShippingExceptionDetail["decision"]>>();
  const versions = new Map<string, number>();
  const results = new Map<string, { hash: string; result: ActionResponse }>();

  const proposals = new Map<string, NonNullable<ReturnDetail["proposal"]>>();
  const transferRequests: TransferRequest[] = [];
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

  /** An audited reveal. It needs an authorized role and a stated reason, and it records who looked. It never leaves the page. */
  function revealCustomer(request: ActionRequest<{ orderRef: string; reason: string }>): ActionResponse {
    const rid = request.requestId;
    if (!(CUSTOMER_ROLES as readonly string[]).includes(actorRole)) fail("SOURCE_AUTHORITY_DENIED", "Your role can't see customer details.", rid);
    if (!orderDemo(request.payload.orderRef)) fail("RECORD_NOT_FOUND", "This order does not exist or was removed.", rid);
    if ((request.payload.reason?.trim().length ?? 0) < 10) fail("VALIDATION_FAILED", "Say why you need to see these details, in at least 10 characters.", rid, { fieldErrors: { reason: "Say why in at least 10 characters." } });
    const entry: CustomerAuditEntry = { id: `CUST-AUD-${customerAudit.length + 1}`, at: DEMO_NOW, role: actorRole, orderRef: request.payload.orderRef, reason: request.payload.reason.trim() };
    customerAudit.push(entry);
    return {
      schemaVersion: SCHEMA_VERSION,
      requestId: rid,
      scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
      actionRef: entry.id,
      state: "succeeded",
      runRef: null,
      approvalRef: null,
      manifestRef: null,
      payloadVersion: `customer-${entry.orderRef}@${customerAudit.length}`,
      policyVersion: "customer-data@demo",
      modelVersion: null,
      offerVersion: null,
      reasonCodes: [],
      receiptRefs: [entry.id],
      nextAction: null,
      nextPollAfterMs: null,
    };
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

  function inventory(request: ReadRequest<{ scenario?: string }>) {
    const scenario = request.filters.scenario;
    if (scenario === "unavailable") fail("SOURCE_UNAVAILABLE", "The inventory mirror could not be reached.", request.requestId, { retryable: true });
    const data = inventoryDemo(scenario);
    data.pendingRequests = structuredClone(transferRequests);
    data.version = `inv${1 + transferRequests.length}`;
    const stale = scenario === "stale";
    const caps: Capability[] = [{ actionKind: "requestStockTransfer", ...(stale ? { state: "held" as const, reasonCodes: ["SOURCE_STALE"] } : { state: "available" as const, reasonCodes: [] }) }];
    return respondWith(request, data, { dataVersion: data.version, dataState: stale ? "stale" : scenario === "delayed" ? "partial" : "ready", capabilities: caps });
  }

  function support(request: ReadRequest<{ caseId: string; scenario?: string }>) {
    const data = supportDemo(request.filters.caseId, request.filters.scenario) ?? fail("RECORD_NOT_FOUND", "This support case does not exist or was removed.", request.requestId);
    return respondWith(request, data, { dataVersion: `support-${data.caseId}@1`, dataState: request.filters.scenario === "stale" ? "stale" : "ready", capabilities: [{ actionKind: "reopenCase", state: "unsupported", reasonCodes: ["INTERCOM_OWNS_CASES"] }] });
  }

  function requestStockTransfer(request: ActionRequest<TransferRequestPayload>): ActionResponse {
    const { from, to, units, reason } = request.payload;
    const inv = inventoryDemo();
    const current = `inv${1 + transferRequests.length}`;
    if (request.expectedVersion !== current) fail("STALE_VERSION", "Stock changed. Reload it before requesting a transfer.", request.requestId, { currentVersion: current });
    const field = (name: string, message: string): never => fail("VALIDATION_FAILED", message, request.requestId, { fieldErrors: { [name]: message } });
    if (!HOMES.includes(from)) field("from", "Choose a home to move stock from.");
    if (!HOMES.includes(to)) field("to", "Choose a home to move stock to.");
    if (from === to) field("to", "The destination must differ from the source.");
    if (!Number.isInteger(units) || units <= 0) field("units", "Enter a whole number of units above zero.");
    const source = inv.rows.find((r) => r.home === from)!;
    const reservedByRequests = transferRequests.filter((t) => t.from === from).reduce((n, t) => n + t.units, 0);
    const available = availableOf(source) - reservedByRequests;
    if (units > available) fail("QUOTA_OR_STOCK_HOLD", `Only ${available} units are available at Home ${from}. Reserved units can't be transferred.`, request.requestId, { fieldErrors: { units: `Only ${available} available at Home ${from}.` } });
    if (!reason.trim()) field("reason", "Enter the operational reason.");
    if (transferRequests.some((t) => t.from === from && t.to === to && t.units === units)) fail("VALIDATION_FAILED", "An identical transfer request is already waiting. A duplicate movement isn't allowed.", request.requestId);
    const response = respond(request, "approvalPending", { reasonCodes: ["AWAITING_APPROVAL"], nextAction: { kind: "sourceReceipt", ownerRef: "Fulfillment", dueAt: null, available: false } });
    transferRequests.push({ key: `REQ-${transferRequests.length + 1}`, from, to, units, reason: reason.trim(), state: "Waiting for approval. No stock has moved." });
    return response;
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
        case "inventoryOverview":
          return inventory(request as ReadRequest<{ scenario?: string }>);
        case "supportWorkspace":
          return support(request as ReadRequest<{ caseId: string; scenario?: string }>);
        case "returnDetail":
          return returnDetail(request as ReadRequest<{ returnId: string; scenario?: string }>);
        case "orderCustomer": {
          const { orderId } = request.filters as { orderId: string };
          if (!orderDemo(orderId)) return fail("RECORD_NOT_FOUND", "This order does not exist or was removed.", request.requestId);
          const allowed = (CUSTOMER_ROLES as readonly string[]).includes(actorRole);
          const audit = customerAudit.filter((a) => a.orderRef === orderId);
          const data: OrderCustomerData = {
            datasetKey: "operations-customer-demo",
            orderRef: orderId,
            access: allowed ? { state: "allowed", reason: null } : { state: "denied", reason: "ROLE_REQUIRED" },
            revealed: allowed && audit.length ? { name: `Test Customer ${orderId.slice(-4)}`, email: `test-${orderId.slice(-4)}@example.test`, city: "Testville" } : null,
            audit,
          };
          return respondWith(request, data, { dataVersion: `customer-${orderId}@${audit.length}`, capabilities: [{ actionKind: "revealCustomerDetails", state: allowed ? "available" : "denied", reasonCodes: allowed ? [] : ["ROLE_REQUIRED"] }] });
        }
        case "operationsShipping":
          return respondWith(request, { datasetKey: "operations-shipping-demo" as const, shipments: shipmentsDemo, exceptions: opsExceptionsDemo, chain: sandboxChain }, { dataVersion: "operations-shipping-demo@1" });
        case "opsHealth":
          return respondWith(request, buildOpsHealth(), { dataVersion: "ops-health@1" });
        case "fulfillmentAnalytics":
          return fulfillment(request as ReadRequest<{ days?: number }>);
        default:
          return null;
      }
    },
    /** Same key and payload returns the original result; the same key with a changed payload is refused. */
    submit(request: ActionRequest<unknown>): ActionResponse | null {
      if (request.actionKind === "revealCustomerDetails") return revealCustomer(request as ActionRequest<{ orderRef: string; reason: string }>);
      if (!["recordShippingDecision", "prepareReturnTask", "requestStockTransfer"].includes(request.actionKind)) return null;
      const hash = JSON.stringify([request.operation, request.actionKind, request.expectedVersion, request.payload]);
      const prior = results.get(request.idempotencyKey);
      if (prior) {
        if (prior.hash !== hash) fail("MANIFEST_CHANGED", "This action changed, so it needs a fresh preview.", request.requestId);
        return prior.result;
      }
      const result = request.actionKind === "requestStockTransfer" ? requestStockTransfer(request as ActionRequest<TransferRequestPayload>) : request.actionKind === "prepareReturnTask" ? prepareReturnTask(request as ActionRequest<ReturnProposalPayload>) : recordShippingDecision(request as ActionRequest<ShippingDecisionPayload>);
      results.set(request.idempotencyKey, { hash, result });
      return result;
    },
  };
}
