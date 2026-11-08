/** Independently authored synthetic native records. This does not connect commerce, shipping or customer authority. */
import type { OperationsReadViewKey } from "./contract.ts";
import type { OperationsReadSourceReader } from "./source.ts";
export const operationsReadTestScope = { workspaceId: "synthetic-operations-workspace", accountId: "synthetic-operations-account", environment: "sandbox" as const };
export const operationsReadTestTime = "2026-11-06T12:00:00.000Z";
const observedAt = "2026-11-06T11:55:00.000Z";
export const operationsReadTestFilters: Record<OperationsReadViewKey, Record<string, string | number>> = {
  operationsOverview: {}, operationsShipping: {}, opsHealth: {}, fulfillmentAnalytics: { days: 14 },
  orderDetail: { orderId: "TEST-SH-1042" }, orderCustomer: { orderId: "TEST-SH-1042" },
  shippingException: { shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-129" }, returnDetail: { returnId: "TEST-RET-028" },
};
export const syntheticCustomer = { name: "Synthetic Customer 1042", email: "synthetic-1042@example.test", city: "Testville" };
export const syntheticAuditReason = "Synthetic private customer conversation must remain withheld.";
const money = (minorUnits: number) => ({ minorUnits, currency: "USD" });
const unknown = (reasonCode: string) => ({ state: "unknown", value: null, reasonCode, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: observedAt, observedAt });
const known = (value: unknown) => ({ ...unknown(""), state: "known", value, reasonCode: null });
const common = () => ({ datasetKey: "operations-native", synthetic: true, provenance: { kind: "source", evidenceStage: "synthetic", observedAt, eventAt: null,
  sourceId: "synthetic-operations-record", canonicalId: null, provenanceRef: "synthetic-operations-evidence" } });
const milestone = { key: "paid", title: "Paid", note: "Synthetic receipt", state: "done" };
export function nativeOrderRecord(orderRef = "TEST-SH-1042"): Record<string, unknown> {
  const unread = orderRef === "TEST-SH-1044";
  return { ...common(), kind: "order", orderRef, sourceKey: "synthetic-order-source", home: "H1", channel: "Synthetic commerce", collaboration: null, discountCode: null,
    attributionLabel: "Unknown", attributionContext: "No attribution evidence", notice: { tone: "warning", label: "Synthetic order", title: "Waiting for shipment · 2.4 days", text: "Synthetic order awaiting source handoff" },
    total: unread ? unknown("PAYMENT_RECEIPT_UNAVAILABLE") : known(money(4000)), totalContext: "Synthetic receipt", refunded: unread ? unknown("REFUND_NOT_OBSERVED") : known(money(0)), refundedContext: "Synthetic known zero",
    mirror: { state: "upToDate", label: "Current", context: "Synthetic mirror" }, milestones: [{ ...milestone }], items: [{ name: "Synthetic item", units: 1, unitPrice: known(money(4000)) }],
    refundPath: [], shipmentRef: null };
}
export function operationsRecord(viewKey: OperationsReadViewKey): Record<string, unknown> {
  const home = { toShip: known(1), waitingOverTwoDays: known(1), shippedToday: known(0), timeToShipDays: unknown("NO_HANDOFF") };
  const average = { days: unknown("NO_SHIPMENTS"), sample: 0 };
  const health = { key: "all", orderToShipped: average, shippedToDelivered: average, costPerOrder: unknown("COST_NOT_READ"), orders: 0, costUnread: 0, deliveredWithoutAcceptance: 0 };
  switch (viewKey) {
    case "operationsOverview": return { ...common(), source: { label: "Synthetic warehouse", lastSyncedAt: observedAt, observedAt }, all: home, byHome: { H1: home, H2: home, H3: home },
      openIssues: known(1), needHumanResponse: 0, queue: { rows: [{ ref: "TEST-SH-1042", kind: "order", home: "H1", waitingHours: 57.6, units: 1, hold: null }], total: 1 },
      stock: [{ home: "H1", onHand: 5, reserved: 1, capacity: 10, threshold: 2 }], transfers: [], exceptions: [],
      health: { carrierTransitDays: unknown("NO_DELIVERIES"), shippingCostPerOrder: unknown("NO_HANDOFF"), onTimeHandoffPct: unknown("NO_HANDOFF") }, warnAfterHours: 48 };
    case "orderDetail": return nativeOrderRecord();
    case "orderCustomer": return { ...common(), orderRef: "TEST-SH-1042", access: { state: "allowed", reason: null }, revealed: { ...syntheticCustomer },
      audit: [{ id: "synthetic-old-audit", at: "2026-11-06T10:00:00.000Z", role: "operations", orderRef: "TEST-SH-1042", reason: syntheticAuditReason }] };
    case "shippingException": return { ...common(), shipmentRef: "TEST-SP-0093", exceptionId: "TEST-EVT-129", version: "synthetic-v1", carrierState: "Lost",
      notice: { tone: "danger", label: "Synthetic carrier event", title: "Shipment marked lost", text: "No remedy is executed" }, carrierEventLabel: "Lost", home: "H1",
      shippingCost: known(money(500)), shippingCostContext: "Synthetic label receipt", lastSyncLabel: "Current", lastSyncContext: "Synthetic mirror", events: [{ ...milestone }],
      postingClockNote: "No creator posting clock", owner: "Synthetic owner", orderKey: "TEST-SH-1042", alert: "Review source", supportCase: "synthetic-case", steps: [], decision: null };
    case "returnDetail": return { ...common(), returnRef: "TEST-RET-028", orderKey: "TEST-SH-1042", version: "synthetic-v1", state: "active", units: 1, home: "H1",
      lifecycle: [{ ...milestone }], selected: { disposition: "quarantine", resolution: "refund", reason: "Synthetic inspection pending" }, inspection: { receiptRef: "synthetic-inspection", resellable: false, units: 1 },
      refundAmount: money(4000), sourceReview: "Synthetic source", pending: { inventoryReceipt: "Pending", refundSettlement: "Pending", quickbooksPosting: "Pending", caseState: "Open" }, proposal: null, resolved: null };
    case "fulfillmentAnalytics": return { ...common(), periodDays: 14, source: "Synthetic source", syncedMinutesAgo: 5, homes: 3, daily: [{ label: "Nov 6", shipped: 0, backlog: 1 }],
      shippedPrior: known(0), onTimePct: unknown("NO_HANDOFF"), awaitingHandoff: known(1), overdue: 1, stock: [{ home: "H1", available: 4, reserved: 1, threshold: 2 }],
      scaleUnits: 1, avgTransitDays: unknown("NO_DELIVERIES"), transit: null, exceptions: { lost: 1, returned: 0 } };
    case "operationsShipping": return { ...common(), shipments: [{ ref: "TEST-SP-0093", orderRef: "TEST-SH-1042", sampleRef: null, home: "H1", requestedAt: "2026-11-04T12:00:00.000Z", eventAt: observedAt,
      carrierState: "lost", lastScan: observedAt, shipmentDetail: { kind: "exception", shipmentRef: "TEST-SP-0093", exceptionRef: "TEST-EVT-129" }, originDetail: { kind: "order", ref: "TEST-SH-1042" } }],
      exceptions: [{ id: "synthetic-exception", kind: "failedScan", ref: "TEST-SP-0093", ageHours: 12, detail: "Synthetic scan missing", next: "Inspect source", to: "/orders/TEST-SH-1042" }], chain: [] };
    case "opsHealth": return { ...common(), issues: { tags: [], refunds: { total: money(0), orders: 0, pending: [] }, fin: { periodLabel: "Synthetic fortnight", resolutions: 0, cost: money(0), cap: money(1000) } },
      fulfillment: { all: health, byHome: [{ ...health, key: "H1" }], byCarrier: [] }, orders: [], integrity: { shipments: 0, duplicatesIgnored: 0, outOfOrder: 0, stockDecrements: 0 } };
  }
}
export function operationsSnapshot(viewKey: OperationsReadViewKey, patch: Record<string, unknown> = {}) {
  return { scope: { ...operationsReadTestScope }, viewKey, version: "synthetic-operations-v1", principalRef: "agent-reader", permissionVersion: "synthetic-permission-v1", observedAt,
    validUntil: "2026-11-06T12:10:00.000Z", coverage: { state: "complete", expectedCount: 1, observedCount: 1, reasonCodes: [] }, record: operationsRecord(viewKey), ...patch };
}
export function operationsTestSource(read: OperationsReadSourceReader["read"]): OperationsReadSourceReader {
  return { async read(scope, request, options) {
    const answer = await read(scope, request, options);
    return answer && typeof answer === "object" ? { ...answer, principalRef: options.principal.principalRef } : answer;
  }, assertCurrent(snapshot, binding) {
    if (snapshot.principalRef !== binding.principal.principalRef || snapshot.permissionVersion !== "synthetic-permission-v1" ||
      JSON.stringify(snapshot.scope) !== JSON.stringify(binding.scope) || snapshot.viewKey !== binding.request.viewKey) throw new Error("Synthetic binding mismatch");
  } };
}
