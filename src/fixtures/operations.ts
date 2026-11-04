/**
 * Operations fixtures (Figma sources 4:6, 4:171, 4:317, 12:292, 12:431, 12:808) — SYNTHETIC.
 * Every identifier is fictional ("TEST-…"). No customer name, contact or address is mirrored. Stock levels,
 * waiting times and costs are illustrative. Do not mix with the Overview, acquisition or finance datasets.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { DEMO_NOW } from "./overview";
import { known, notApplicable, unknown, usd } from "./values";

export type Home = "H1" | "H2" | "H3";
export const HOMES: Home[] = ["H1", "H2", "H3"];
export const homeLabel = (home: Home) => `Home ${home}`;

export type SourceFreshness = { label: string; lastSyncedAt: string | null; observedAt: string };

export type QueueRow = {
  ref: string;
  kind: "order" | "sample";
  home: Home;
  waitingHours: number;
  units: number;
  /** A held row is not ready to dispatch. It names why, and the source action that clears it. */
  hold: { reason: string; sourceAction: string } | null;
};

export type HomeStock = { home: Home; onHand: number; reserved: number; capacity: number; threshold: number };
export type ShipmentException = { shipmentRef: string; exceptionId: string; state: "Lost" | "Returned"; home: Home };

export type HomeSummary = { toShip: ProvenanceValue<number>; waitingOverTwoDays: ProvenanceValue<number>; shippedToday: ProvenanceValue<number>; timeToShipDays: ProvenanceValue<number> };

export type OperationsOverview = {
  datasetKey: "operations-demo";
  source: SourceFreshness;
  all: HomeSummary;
  byHome: Record<Home, HomeSummary>;
  openIssues: ProvenanceValue<number>;
  needHumanResponse: number;
  queue: { rows: QueueRow[]; total: number };
  stock: HomeStock[];
  transfers: { ref: string; toHome: Home; state: string }[];
  exceptions: ShipmentException[];
  health: { carrierTransitDays: ProvenanceValue<number>; shippingCostPerOrder: ProvenanceValue<Money>; onTimeHandoffPct: ProvenanceValue<number> };
  warnAfterHours: number;
};

const q = (ref: string, home: Home, waitingHours: number, units: number, hold: QueueRow["hold"] = null): QueueRow => ({ ref, kind: ref.includes("-SC-") ? "sample" : "order", home, waitingHours, units, hold });

export const operationsDemo: OperationsOverview = {
  datasetKey: "operations-demo",
  source: { label: "Sheets warehouse", lastSyncedAt: "2026-11-02T16:57:00.000Z", observedAt: DEMO_NOW },
  all: { toShip: known(18), waitingOverTwoDays: known(4), shippedToday: known(26), timeToShipDays: known(1.2) },
  byHome: {
    H1: { toShip: known(8), waitingOverTwoDays: known(2), shippedToday: known(12), timeToShipDays: known(1.1) },
    H2: { toShip: known(6), waitingOverTwoDays: known(2), shippedToday: known(9), timeToShipDays: known(1.4) },
    H3: { toShip: known(4), waitingOverTwoDays: known(0), shippedToday: known(5), timeToShipDays: known(1.0) },
  },
  openIssues: known(7),
  needHumanResponse: 2,
  queue: {
    total: 18,
    rows: [q("TEST-SH-1042", "H1", 57.6, 2), q("TEST-SC-0081", "H2", 50.4, 2), q("TEST-TT-1038", "H1", 31.2, 1), q("TEST-SH-1045", "H3", 16, 1), q("TEST-SC-0085", "H2", 8, 1)],
  },
  stock: [
    { home: "H1", onHand: 100, reserved: 14, capacity: 120, threshold: 20 },
    { home: "H2", onHand: 28, reserved: 10, capacity: 80, threshold: 20 },
    { home: "H3", onHand: 68, reserved: 4, capacity: 100, threshold: 20 },
  ],
  transfers: [{ ref: "TEST-TR-012", toHome: "H2", state: "in transit" }],
  exceptions: [
    { shipmentRef: "TEST-SP-0093", exceptionId: "TEST-EVT-129", state: "Lost", home: "H2" },
    { shipmentRef: "TEST-SP-0091", exceptionId: "TEST-EVT-127", state: "Returned", home: "H1" },
  ],
  health: { carrierTransitDays: known(3.4), shippingCostPerOrder: known(usd(685)), onTimeHandoffPct: known(94) },
  warnAfterHours: 48,
};

/** Rows the demo shows when asked for held work: an unapproved sample, an unresolved identity and a stock shortage. */
export const heldRows: QueueRow[] = [
  q("TEST-SC-0090", "H2", 20, 1, { reason: "Sample not approved yet", sourceAction: "Approve the sample in the creator record" }),
  q("TEST-SH-1050", "H1", 12, 1, { reason: "Customer identity unresolved", sourceAction: "Resolve the order's identity in Shopify" }),
  q("TEST-TT-1047", "H2", 30, 1, { reason: "Not enough available stock at Home H2", sourceAction: "Transfer stock or choose another home" }),
];

export type MilestoneState = "done" | "current" | "pending" | "problem";
export type Milestone = { key: string; title: string; note: string; state: MilestoneState };
export type OrderDetail = {
  datasetKey: "operations-demo";
  kind: "order" | "sample";
  orderRef: string;
  sourceKey: string;
  home: Home;
  channel: string;
  collaboration: string | null;
  discountCode: string | null;
  attributionLabel: string;
  attributionContext: string;
  notice: { tone: "warning" | "violet" | "success" | "danger"; label: string; title: string; text: string };
  total: ProvenanceValue<Money>;
  totalContext: string;
  refunded: ProvenanceValue<Money>;
  refundedContext: string;
  mirror: { state: "upToDate" | "stale"; label: string; context: string };
  milestones: Milestone[];
  items: { name: string; units: number; unitPrice: ProvenanceValue<Money> }[];
  refundPath: { key: string; label: string; note: string; reached: boolean }[];
  shipmentRef: string | null;
};

export type ShipmentTimelineEvent = { key: string; title: string; note: string; state: MilestoneState };
export type ShippingExceptionDetail = {
  datasetKey: "operations-demo";
  shipmentRef: string;
  exceptionId: string;
  version: string;
  carrierState: "Lost" | "Returned";
  notice: { tone: "danger" | "warning"; label: string; title: string; text: string };
  carrierEventLabel: string;
  home: Home;
  shippingCost: ProvenanceValue<Money>;
  shippingCostContext: string;
  lastSyncLabel: string;
  lastSyncContext: string;
  events: ShipmentTimelineEvent[];
  postingClockNote: string;
  owner: string;
  orderKey: string;
  alert: string;
  supportCase: string;
  steps: string[];
  /** A decision already recorded for this exception, if any. The page can't create or replace one without a fresh version. */
  decision: { choice: "refund" | "replacement"; reason: string; state: string } | null;
};

const unitPrice = known(usd(3499));

export const orderDemo = (orderRef: string): OrderDetail | null => {
  if (orderRef === "TEST-SH-1042")
    return {
      datasetKey: "operations-demo",
      kind: "order",
      orderRef,
      sourceKey: "SHOP-TEST-1042",
      home: "H1",
      channel: "Shopify",
      collaboration: "TEST-COL-018",
      discountCode: "FARDA-TEST018",
      attributionLabel: "Creator code",
      attributionContext: "Code wins over UTM and platform",
      notice: { tone: "warning", label: "Review", title: "Waiting for shipment · 2.4 days", text: "Home H1 owns fulfillment. Customer contact and address stay in Shopify." },
      total: known(usd(6998)),
      totalContext: "2 units · paid · demo order",
      refunded: known(usd(0)),
      refundedContext: "No refund recorded",
      mirror: { state: "upToDate", label: "Up to date", context: "Last synced 3 minutes ago" },
      milestones: [
        { key: "paid", title: "Paid", note: "Shopify payment captured · Oct 27, 10:42 AM", state: "done" },
        { key: "ready", title: "Ready to pick", note: "2 units allocated to Home H1 · label not purchased", state: "current" },
        { key: "handoff", title: "Carrier handoff", note: "Pending · label purchase does not mean shipped", state: "pending" },
        { key: "delivered", title: "Delivered", note: "Pending carrier confirmation", state: "pending" },
      ],
      items: [{ name: "Farda device · Graphite", units: 2, unitPrice }],
      refundPath: [
        { key: "requested", label: "Refund requested", note: "Support decision in Intercom", reached: false },
        { key: "posted", label: "Refund posted", note: "Shopify amount → QuickBooks", reached: false },
        { key: "received", label: "Return received", note: "Inspect condition in source", reached: false },
        { key: "stock", label: "Stock reconciled", note: "Restock or damage movement", reached: false },
      ],
      shipmentRef: null,
    };
  if (orderRef === "TEST-SH-1031")
    return {
      datasetKey: "operations-demo",
      kind: "order",
      orderRef,
      sourceKey: "SHOP-TEST-1031",
      home: "H2",
      channel: "Shopify",
      collaboration: null,
      discountCode: null,
      attributionLabel: "Unattributed",
      attributionContext: "No code, UTM or platform match",
      notice: { tone: "danger", label: "Action needed", title: "Shipment marked lost", text: "The carrier reported this shipment lost. Open the exception before replacing the order." },
      total: known(usd(3499)),
      totalContext: "1 unit · paid · demo order",
      refunded: known(usd(0)),
      refundedContext: "No refund recorded",
      mirror: { state: "stale", label: "Behind", context: "Last synced 41 minutes ago" },
      milestones: [
        { key: "paid", title: "Order paid", note: "Shopify payment captured · Oct 26, 9:05 AM", state: "done" },
        { key: "label", title: "Label created", note: "Shippo transaction TEST-TX-093 · Oct 26, 11:02 AM", state: "done" },
        { key: "accepted", title: "Carrier accepted", note: "Oct 26, 2:15 PM · shipping clock starts", state: "done" },
        { key: "shipped", title: "Shipped", note: "In transit · Oct 27, 4:32 PM scan", state: "done" },
        { key: "delivered", title: "Delivered", note: "Not delivered. The carrier reported it lost · Oct 29, 8:12 AM", state: "problem" },
        { key: "return", title: "Return received", note: "Not started", state: "pending" },
        { key: "refund", title: "Refund", note: "Not started · no refund recorded", state: "pending" },
        { key: "replacement", title: "Replacement", note: "Not started · no replacement order exists", state: "pending" },
      ],
      items: [{ name: "Farda device · Graphite", units: 1, unitPrice }],
      refundPath: [
        { key: "requested", label: "Refund requested", note: "Support decision in Intercom", reached: false },
        { key: "posted", label: "Refund posted", note: "Shopify amount → QuickBooks", reached: false },
        { key: "received", label: "Return received", note: "Inspect condition in source", reached: false },
        { key: "stock", label: "Stock reconciled", note: "Restock or damage movement", reached: false },
      ],
      shipmentRef: "TEST-SP-0093",
    };
  if (orderRef === "TEST-SC-0081")
    return {
      datasetKey: "operations-demo",
      kind: "sample",
      orderRef,
      sourceKey: "SHOP-TEST-SC-0081",
      home: "H2",
      channel: "Creator sample · native order",
      collaboration: "TEST-COL-021",
      discountCode: null,
      attributionLabel: "Not applicable",
      attributionContext: "A sample is not a sale",
      notice: { tone: "warning", label: "Review", title: "Approved sample waiting · 2.1 days", text: "Approved separately from any offer. No label has been purchased." },
      total: notApplicable("SAMPLE_NOT_SOLD"),
      totalContext: "2 units · approved sample · no revenue",
      refunded: notApplicable("SAMPLE_NOT_SOLD"),
      refundedContext: "Samples have no refund",
      mirror: { state: "upToDate", label: "Up to date", context: "Last synced 3 minutes ago" },
      milestones: [
        { key: "approved", title: "Sample approved", note: "Approved in the creator record · Oct 28, 9:30 AM", state: "done" },
        { key: "ready", title: "Ready to pick", note: "2 units allocated to Home H2 · label not purchased", state: "current" },
        { key: "handoff", title: "Carrier handoff", note: "Pending · label purchase does not mean shipped", state: "pending" },
        { key: "delivered", title: "Delivered", note: "Pending carrier confirmation. The posting clock starts only after delivery", state: "pending" },
      ],
      items: [{ name: "Farda device · Graphite (sample)", units: 2, unitPrice: notApplicable("SAMPLE_NOT_SOLD") }],
      refundPath: [],
      shipmentRef: null,
    };
  return null;
};

export const shippingExceptionDemo = (shipmentRef: string, exceptionId: string): ShippingExceptionDetail | null => {
  if (shipmentRef !== "TEST-SP-0093" || exceptionId !== "TEST-EVT-129") return null;
  return {
    datasetKey: "operations-demo",
    shipmentRef,
    exceptionId,
    version: "ex1",
    carrierState: "Lost",
    notice: { tone: "danger", label: "Action needed", title: "Shipment marked lost", text: "Assign the next step in the source before replacing the order. Reconcile the original shipment and any new label." },
    carrierEventLabel: "Carrier event · Oct 29, 8:12 AM",
    home: "H2",
    shippingCost: known(usd(675)),
    shippingCostContext: "$5.95 label + $0.80 packaging",
    lastSyncLabel: "4 min ago",
    lastSyncContext: "Fresh mirror · failed delivery",
    events: [
      { key: "lost", title: "Lost by carrier", note: "Oct 29, 8:12 AM · exception ID TEST-EVT-129", state: "problem" },
      { key: "transit", title: "In transit", note: "Oct 27, 4:32 PM · scanned at distribution center", state: "done" },
      { key: "accepted", title: "Accepted by carrier", note: "Oct 26, 2:15 PM · shipping clock starts", state: "done" },
      { key: "label", title: "Label purchased", note: "Oct 26, 11:02 AM · Shippo transaction TEST-TX-093", state: "done" },
    ],
    postingClockNote: "For creator samples, the posting clock starts only after confirmed delivery. Customer shipments have no creator posting obligation.",
    owner: "Fulfillment · Home H2",
    orderKey: "SHOP-TEST-1031",
    alert: "#ops-alerts · delivered",
    supportCase: "TEST-ISS-021",
    steps: ["Confirm carrier outcome", "Choose refund or replacement", "Record decision and new source ID", "Verify Zapier mirror receipt"],
    decision: null,
  };
};


export type ReturnDisposition = "restock" | "quarantine";
export type ReturnResolution = "refund" | "replacement";
export type ReturnDetail = {
  datasetKey: "operations-demo";
  returnRef: string;
  orderKey: string;
  version: string;
  state: "active" | "resolved";
  units: number;
  home: Home;
  lifecycle: Milestone[];
  /** What the source record currently selects. The page edits a draft of this and never changes it directly. */
  selected: { disposition: ReturnDisposition; resolution: ReturnResolution; reason: string };
  /** Resellable verdict comes from the inspection receipt, not from the fixture's say-so. */
  inspection: { receiptRef: string; resellable: boolean; units: number };
  refundAmount: Money;
  sourceReview: string;
  pending: { inventoryReceipt: string; refundSettlement: string; quickbooksPosting: string; caseState: string };
  proposal: { state: string; actionRef: string } | null;
  resolved: null | {
    chain: { outcome: string; receipt: string; confirmedAt: string }[];
    refunded: Money;
    returnedUnits: number;
    restockedUnits: number;
    retainedUnits: number;
    replacement: string;
    caseRef: string;
  };
};

export const returnDemo = (returnRef: string, scenario?: string): ReturnDetail | null => {
  if (returnRef !== "TEST-RET-028") return null;
  const resolved = scenario === "resolved";
  return {
    datasetKey: "operations-demo",
    returnRef,
    orderKey: "SHOP-TEST-1028",
    version: "ret1",
    state: resolved ? "resolved" : "active",
    units: 1,
    home: "H3",
    lifecycle: [
      { key: "authorized", title: "Authorized", note: "Return TEST-RET-028 linked to SHOP-TEST-1028", state: "done" },
      { key: "received", title: "Received", note: "1 unit received at Home H3 · carrier receipt confirmed", state: "done" },
      { key: "inspected", title: "Inspected", note: "Resellable · quantity 1 · inspection receipt TEST-INSP-028", state: "done" },
      { key: "stock", title: "Restock or quarantine", note: "Selected: restock 1. Source movement is not posted yet.", state: "current" },
      { key: "refund", title: "Refund or replacement", note: "Selected: refund $34.99. Source payment receipt required.", state: "pending" },
      { key: "close", title: "Close & reconcile", note: "Close only after stock, refund and ledger receipts agree.", state: "pending" },
    ],
    selected: { disposition: "restock", resolution: "refund", reason: "Return inspected · resellable" },
    inspection: { receiptRef: "TEST-INSP-028", resellable: true, units: 1 },
    refundAmount: usd(3499),
    sourceReview: "Source review required",
    pending: { inventoryReceipt: "Pending", refundSettlement: "Pending", quickbooksPosting: "Pending", caseState: "Open · awaiting receipts" },
    proposal: null,
    resolved: resolved
      ? {
          chain: [
            { outcome: "Restock +1 · Home H3", receipt: "TEST-MOV-0201", confirmedAt: "Oct 29, 11:42 AM" },
            { outcome: "Refund $34.99 settled", receipt: "TEST-REF-1028-1", confirmedAt: "Oct 29, 11:44 AM" },
            { outcome: "QuickBooks reversal posted", receipt: "TEST-QB-REV-028", confirmedAt: "Oct 29, 11:45 AM" },
            { outcome: "Mirrors refreshed", receipt: "TEST-RUN-4492", confirmedAt: "Oct 29, 11:46 AM" },
            { outcome: "Support case closed", receipt: "TEST-ISS-018", confirmedAt: "Oct 29, 11:47 AM" },
          ],
          refunded: usd(3499),
          returnedUnits: 1,
          restockedUnits: 1,
          retainedUnits: 1,
          replacement: "Not selected",
          caseRef: "TEST-ISS-018",
        }
      : null,
  };
};

export type FulfillmentDay = { label: string; shipped: number; backlog: number };
export type FulfillmentAnalytics = {
  datasetKey: "operations-demo";
  periodDays: 7 | 14;
  source: string;
  syncedMinutesAgo: number;
  homes: number;
  daily: FulfillmentDay[];
  shippedPrior: ProvenanceValue<number>;
  onTimePct: ProvenanceValue<number>;
  awaitingHandoff: ProvenanceValue<number>;
  overdue: number;
  stock: { home: Home; available: number; reserved: number; threshold: number }[];
  scaleUnits: number;
  avgTransitDays: ProvenanceValue<number>;
  /** Share of delivered orders by transit time. Null when the period has no delivery distribution. */
  transit: { label: string; share: number; warn?: boolean }[] | null;
  exceptions: { lost: number; returned: number };
};

const DAILY: FulfillmentDay[] = [
  ["16 Oct", 12, 22], ["17", 19, 25], ["18", 21, 20], ["19", 16, 28], ["20", 28, 24], ["21", 24, 19], ["22", 32, 26],
  ["23", 26, 22], ["24", 18, 27], ["25", 22, 25], ["26", 29, 18], ["27", 25, 21], ["28", 31, 20], ["29", 26, 18],
].map(([label, shipped, backlog]) => ({ label: label as string, shipped: shipped as number, backlog: backlog as number }));

export const fulfillmentDemo = (periodDays: 7 | 14): FulfillmentAnalytics => ({
  datasetKey: "operations-demo",
  periodDays,
  source: "Sheets + Shippo",
  syncedMinutesAgo: 3,
  homes: 3,
  daily: periodDays === 14 ? DAILY : DAILY.slice(-7),
  shippedPrior: periodDays === 14 ? known(279) : unknown("PRIOR_PERIOD_NOT_IN_DEMO"),
  onTimePct: known(94),
  awaitingHandoff: known(18),
  overdue: 4,
  stock: [
    { home: "H1", available: 86, reserved: 14, threshold: 20 },
    { home: "H2", available: 18, reserved: 10, threshold: 20 },
    { home: "H3", available: 64, reserved: 4, threshold: 20 },
  ],
  scaleUnits: 120,
  avgTransitDays: known(3.4),
  transit: periodDays === 14 ? [{ label: "1–2 days", share: 32 }, { label: "3–4 days", share: 51 }, { label: "5–6 days", share: 13 }, { label: "7+ days", share: 4, warn: true }] : null,
  exceptions: { lost: 1, returned: 1 },
});
