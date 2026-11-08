/**
 * Runtime schemas for the operations views and actions: operations, orders, shipping, returns, fulfillment,
 * stock, inventory and support. They parse `ReadResponse.data` (see `readResponseSchema`) and action payloads.
 *
 * Strictness: `.strict()` is used only where an unexpected key is a real risk, not as a default.
 *  - `orderDetail` and `supportWorkspace` (and the support case): these views mirror only safe operational fields. A
 *    customer name, email, address or conversation text arriving under a new key must be rejected, not silently
 *    stripped or passed through to a screen.
 *  - Action payloads: a key the approver never saw is a parameter nobody approved.
 * Everything else uses zod's default (unknown keys are stripped), so the server can add display fields without a
 * client release.
 *
 * Value states: counts, days, money and percentages that can be unknown use `provenanceValueSchema` from the contract,
 * so a known zero (state known, value 0), unknown and N/A stay three different things, a null known value is rejected and
 * an unknown value that carries a number is rejected. Plain numbers (no provenance wrapper) are never nullable here.
 * Money is the contract's `moneySchema` narrowed to non-negative minor units: every money field in this area is a price,
 * a cost or a refund amount, and a negative one is a server bug, not a credit.
 *
 * `datasetKey` is the in-band demo label. It is a plain non-empty string, not a literal, so live data can carry its own key.
 * A live adapter in sandbox or production should refuse a key that names a demo dataset; that is an adapter decision.
 */
import { z } from "zod";
import { nativeInventorySchema, nativeSupportSchema, transferIntent, handoffIntent } from "../../creator-agent/stockSupportSchema.ts";
import { moneySchema, provenanceValueSchema } from "../contract.ts";
import { receiptBackedResponse } from "./approvals.ts";

const HOMES = ["H1", "H2", "H3"] as const;
export const homeSchema = z.enum(HOMES);

export const nonNegativeMoneySchema = moneySchema.extend({
  minorUnits: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const count = z.number().int().nonnegative();
const nonBlank = z.string().trim().min(1);
const datasetKey = z.string().min(1);
const iso = z.string().datetime({ offset: true });

const pvCount = provenanceValueSchema(count);
const pvDays = provenanceValueSchema(z.number().nonnegative());
const pvPct = provenanceValueSchema(z.number().min(0).max(100));
const pvMoney = provenanceValueSchema(nonNegativeMoneySchema);

const milestoneState = z.enum(["done", "current", "pending", "problem"]);
const milestone = z.object({ key: z.string(), title: z.string(), note: z.string(), state: milestoneState });
const tone = z.enum(["warning", "violet", "success", "danger"]);
const notice = <T extends z.ZodTypeAny>(tones: T) => z.object({ tone: tones, label: z.string(), title: z.string(), text: z.string() });

/* ---------- operations overview (operationsOverview) ---------- */

const homeSummary = z.object({ toShip: pvCount, waitingOverTwoDays: pvCount, shippedToday: pvCount, timeToShipDays: pvDays });
const queueRow = z.object({
  ref: nonBlank,
  kind: z.enum(["order", "sample"]),
  home: homeSchema,
  waitingHours: z.number().nonnegative(),
  units: count,
  hold: z.object({ reason: nonBlank, sourceAction: nonBlank }).nullable(),
});

export const operationsOverviewSchema = z
  .object({
    datasetKey,
    source: z.object({ label: z.string(), lastSyncedAt: iso.nullable(), observedAt: iso }),
    all: homeSummary,
    byHome: z.object({ H1: homeSummary, H2: homeSummary, H3: homeSummary }),
    openIssues: pvCount,
    needHumanResponse: count,
    queue: z.object({ rows: z.array(queueRow), total: count }),
    stock: z.array(z.object({ home: homeSchema, onHand: count, reserved: count, capacity: count, threshold: count })),
    transfers: z.array(z.object({ ref: nonBlank, toHome: homeSchema, state: z.string() })),
    exceptions: z.array(z.object({ shipmentRef: nonBlank, exceptionId: nonBlank, state: z.enum(["Lost", "Returned"]), home: homeSchema })),
    health: z.object({ carrierTransitDays: pvDays, shippingCostPerOrder: pvMoney, onTimeHandoffPct: pvPct }),
    warnAfterHours: z.number().positive(),
  })
  .superRefine((v, ctx) => {
    if (v.queue.rows.length > v.queue.total) ctx.addIssue({ code: "custom", path: ["queue", "total"], message: "Queue total is smaller than the rows returned" });
  });

/* ---------- order and sample (orderDetail) ---------- */

export const orderDetailSchema = z
  .object({
    datasetKey,
    kind: z.enum(["order", "sample"]),
    orderRef: nonBlank,
    sourceKey: nonBlank,
    home: homeSchema,
    channel: z.string(),
    collaboration: z.string().nullable(),
    discountCode: z.string().nullable(),
    attributionLabel: z.string(),
    attributionContext: z.string(),
    notice: notice(tone),
    total: pvMoney,
    totalContext: z.string(),
    refunded: pvMoney,
    refundedContext: z.string(),
    mirror: z.object({ state: z.enum(["upToDate", "stale"]), label: z.string(), context: z.string() }),
    milestones: z.array(milestone).min(1),
    items: z.array(z.object({ name: nonBlank, units: z.number().int().positive(), unitPrice: pvMoney })),
    refundPath: z.array(z.object({ key: z.string(), label: z.string(), note: z.string(), reached: z.boolean() })),
    shipmentRef: z.string().nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // A sample is not a sale: it has no revenue and no refund, so those can only be N/A or unknown, never a number.
    if (v.kind === "sample") {
      for (const field of ["total", "refunded"] as const) if (v[field].state === "known") ctx.addIssue({ code: "custom", path: [field], message: "A sample has no revenue or refund" });
    }
  });

/* ---------- shipping exception (shippingException) ---------- */

export const shippingExceptionSchema = z.object({
  datasetKey,
  shipmentRef: nonBlank,
  exceptionId: nonBlank,
  version: nonBlank,
  carrierState: z.enum(["Lost", "Returned"]),
  notice: notice(z.enum(["danger", "warning"])),
  carrierEventLabel: z.string(),
  home: homeSchema,
  shippingCost: pvMoney,
  shippingCostContext: z.string(),
  lastSyncLabel: z.string(),
  lastSyncContext: z.string(),
  events: z.array(milestone),
  postingClockNote: z.string(),
  owner: z.string(),
  orderKey: z.string(),
  alert: z.string(),
  supportCase: z.string(),
  steps: z.array(z.string()),
  decision: z.object({ choice: z.enum(["refund", "replacement"]), reason: nonBlank, state: z.string() }).nullable(),
});

/* ---------- inventory (inventoryOverview) ---------- */

const transferRequest = z.object({ key: nonBlank, from: homeSchema, to: homeSchema, units: z.number().int().positive(), reason: nonBlank, state: z.string() });

export const inventoryOverviewSchema = z.object({
  datasetKey,
  version: nonBlank,
  sku: nonBlank,
  syncedMinutesAgo: count.nullable(),
  rows: z.array(z.object({ home: homeSchema, sku: nonBlank, onHand: count, reserved: count, threshold: count, shopifyObserved: pvCount })),
  movements: z.array(
    z.object({
      key: nonBlank,
      type: z.string(),
      home: homeSchema,
      effect: z.object({ field: z.enum(["available", "onHand"]), delta: z.number().int() }),
      complete: z.boolean(),
      missing: z.string().optional(),
    }),
  ),
  transfer: z
    .object({
      key: nonBlank,
      from: homeSchema,
      to: homeSchema,
      expectedUnits: z.number().int().positive(),
      receivedUnits: pvCount,
      stage: z.enum(["requested", "dispatched", "received"]),
    })
    .superRefine((t, ctx) => {
      // A received count is unknown until the destination confirms it. A transfer can't be "received" without that count.
      if (t.stage === "received" && t.receivedUnits.state !== "known") ctx.addIssue({ code: "custom", path: ["receivedUnits"], message: "A received transfer needs a known received count" });
    }),
  pendingRequests: z.array(transferRequest),
});

/* ---------- support (supportWorkspace) ---------- */

const supportCase = z
  .object({
    id: nonBlank,
    orderRef: nonBlank,
    type: z.string(),
    state: z.enum(["Needs reply", "Waiting", "In review", "Resolved"]),
    owner: z.string(),
    status: z.string(),
    linkedShipment: z.string().nullable(),
    linkedReturn: z.string().nullable(),
    updatedMinutesAgo: count,
    nextStep: z.string(),
    canReopen: z.boolean(),
    version: nonBlank,
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.canReopen && c.state !== "Resolved") ctx.addIssue({ code: "custom", path: ["canReopen"], message: "Only a resolved case can be reopened" });
  });

export const supportWorkspaceSchema = z
  .object({
    datasetKey,
    caseId: nonBlank,
    case: supportCase,
    queue: z.array(supportCase),
    allTimeOpen: pvCount,
    cohort: z.object({ days: z.literal(14), tickets: z.array(z.object({ label: z.string(), count })), resolvedFirstContact: count, open: count, returns: count, deliveredUnits: count, reviews: count }),
    fin: z.object({ cost: nonNegativeMoneySchema, cap: nonNegativeMoneySchema }),
    outcomes: z.object({ refundedAmount: nonNegativeMoneySchema, refundedOrders: count, replacementShipments: count }),
    source: z.object({ label: z.string(), syncedMinutesAgo: count }),
  })
  .strict();

/* ---------- return (returnDetail) ---------- */

export const returnDetailSchema = z
  .object({
    datasetKey,
    returnRef: nonBlank,
    orderKey: nonBlank,
    version: nonBlank,
    state: z.enum(["active", "resolved"]),
    units: z.number().int().positive(),
    home: homeSchema,
    lifecycle: z.array(milestone).min(1),
    selected: z.object({ disposition: z.enum(["restock", "quarantine"]), resolution: z.enum(["refund", "replacement"]), reason: z.string() }),
    inspection: z.object({ receiptRef: nonBlank, resellable: z.boolean(), units: count }),
    refundAmount: nonNegativeMoneySchema,
    sourceReview: z.string(),
    pending: z.object({ inventoryReceipt: z.string(), refundSettlement: z.string(), quickbooksPosting: z.string(), caseState: z.string() }),
    proposal: z.object({ state: z.string(), actionRef: nonBlank }).nullable(),
    resolved: z
      .object({
        chain: z.array(z.object({ outcome: z.string(), receipt: nonBlank, confirmedAt: z.string() })).min(1),
        refunded: nonNegativeMoneySchema,
        returnedUnits: count,
        restockedUnits: count,
        retainedUnits: count,
        replacement: z.string(),
        caseRef: nonBlank,
      })
      .nullable(),
  })
  .superRefine((r, ctx) => {
    if ((r.state === "resolved") !== (r.resolved !== null)) ctx.addIssue({ code: "custom", path: ["resolved"], message: "A resolved return carries its receipt chain; an active one does not" });
    // The resellable verdict comes from the inspection receipt. A restock can't be selected without it.
    if (r.selected.disposition === "restock" && !r.inspection.resellable) ctx.addIssue({ code: "custom", path: ["selected", "disposition"], message: "Restock needs a resellable inspection" });
  });

/* ---------- fulfillment analytics (fulfillmentAnalytics) ---------- */

export const fulfillmentAnalyticsSchema = z.object({
  datasetKey,
  periodDays: z.union([z.literal(7), z.literal(14)]),
  source: z.string(),
  syncedMinutesAgo: count,
  homes: z.number().int().positive(),
  daily: z.array(z.object({ label: z.string(), shipped: count, backlog: count })),
  shippedPrior: pvCount,
  onTimePct: pvPct,
  awaitingHandoff: pvCount,
  overdue: count,
  stock: z.array(z.object({ home: homeSchema, available: z.number().int(), reserved: count, threshold: count })),
  scaleUnits: z.number().int().positive(),
  avgTransitDays: pvDays,
  transit: z.array(z.object({ label: z.string(), share: z.number().min(0).max(100), warn: z.boolean().optional() })).nullable(),
  exceptions: z.object({ lost: count, returned: count }),
});

/** Shipments, exception kinds and the sandbox chain. "In transit" is computed from carrier states on the screen, never stored here. */
export const operationsShippingSchema = z.object({
  datasetKey: z.literal("operations-shipping-demo"),
  shipments: z.array(z.object({ ref: z.string(), orderRef: z.string(), carrierState: z.enum(["labelCreated", "inTransit", "outForDelivery", "deliveredUnconfirmed", "delivered", "lost", "returned"]), lastScan: z.string().nullable() })),
  exceptions: z.array(z.object({ id: z.string(), kind: z.enum(["aging", "failedLabel", "failedScan", "duplicateShipment", "stockShortage", "uncertainRefund"]), ref: z.string(), ageHours: z.number().nonnegative(), detail: z.string(), next: z.string(), to: z.string() })),
  chain: z.array(z.object({ key: z.enum(["order", "sample", "shortage", "transfer"]), label: z.string(), ref: z.string(), state: z.string(), to: z.string() })),
});

/** Restricted customer details. They are present only when access is allowed and a reveal has been audited. */
export const orderCustomerSchema = z
  .object({
    datasetKey: z.literal("operations-customer-demo"),
    orderRef: z.string(),
    access: z.object({ state: z.enum(["allowed", "denied"]), reason: z.string().nullable() }),
    revealed: z.object({ name: z.string(), email: z.string(), city: z.string() }).nullable(),
    audit: z.array(z.object({ id: z.string(), at: z.string(), role: z.string(), orderRef: z.string(), reason: z.string() })),
  })
  .refine((d) => d.revealed === null || (d.access.state === "allowed" && d.audit.length > 0), { message: "Details are never shown without allowed access and an audit entry" });

/* ---------- issues and fulfillment health (opsHealth) ---------- */

const healthAverage = z.object({ days: pvDays, sample: count });
const healthGroup = z.object({ key: nonBlank, orderToShipped: healthAverage, shippedToDelivered: healthAverage, costPerOrder: pvMoney, orders: count, costUnread: count, deliveredWithoutAcceptance: count });
const shipmentState = z.enum(["Delivered", "In transit", "Lost", "Returned", "Label uncertain"]);

export const opsHealthSchema = z.object({
  datasetKey,
  issues: z.object({
    tags: z.array(z.object({ tag: nonBlank, thisWeek: count, lastWeek: count })),
    refunds: z.object({ total: nonNegativeMoneySchema, orders: count, pending: z.array(z.object({ orderRef: nonBlank, amount: nonNegativeMoneySchema })) }),
    fin: z.object({ periodLabel: z.string(), resolutions: count, cost: nonNegativeMoneySchema, cap: nonNegativeMoneySchema }),
  }),
  fulfillment: z.object({ all: healthGroup, byHome: z.array(healthGroup), byCarrier: z.array(healthGroup) }),
  orders: z.array(z.object({ orderRef: nonBlank, reservationRef: nonBlank, shipmentRef: nonBlank.nullable(), home: homeSchema.nullable(), state: z.union([shipmentState, z.literal("Canceled"), z.literal("Partially fulfilled")]), unitsOrdered: count, unitsShipped: count, note: z.string() })),
  integrity: z.object({ shipments: count, duplicatesIgnored: count, outOfOrder: count, stockDecrements: count }),
});

export const opsViewSchemas: Record<string, z.ZodTypeAny> = {
  operationsOverview: operationsOverviewSchema,
  orderDetail: orderDetailSchema,
  shippingException: shippingExceptionSchema,
  inventoryOverview: z.union([nativeInventorySchema,inventoryOverviewSchema]),
  supportWorkspace: z.union([nativeSupportSchema,supportWorkspaceSchema]),
  returnDetail: returnDetailSchema,
  fulfillmentAnalytics: fulfillmentAnalyticsSchema,
  operationsShipping: operationsShippingSchema,
  orderCustomer: orderCustomerSchema,
  opsHealth: opsHealthSchema,
};

/* ---------- actions ---------- */

/** All three are source-owned intents sent through `requestApproval`. Accepting one queues it; it moves no stock and pays nothing. */
export const recordShippingDecisionPayload = z.object({ shipmentRef: nonBlank, exceptionId: nonBlank, decision: z.enum(["refund", "replacement"]), reason: nonBlank }).strict();
export const prepareReturnTaskPayload = z
  .object({ returnRef: nonBlank, disposition: z.enum(["restock", "quarantine"]), resolution: z.enum(["refund", "replacement"]), reason: nonBlank })
  .strict();
export const requestStockTransferPayload = z
  .object({ from: homeSchema, to: homeSchema, units: z.number().int().positive(), reason: nonBlank })
  .strict()
  .superRefine((p, ctx) => {
    if (p.from === p.to) ctx.addIssue({ code: "custom", path: ["to"], message: "The destination must differ from the source" });
  });

export const opsActionSchemas: Record<string, { payload: z.ZodTypeAny }> = {
  recordShippingDecision: { payload: recordShippingDecisionPayload },
  prepareReturnTask: { payload: prepareReturnTaskPayload },
  requestStockTransfer: { payload: z.union([requestStockTransferPayload,transferIntent]) },
  requestSupportHandoff: { payload: handoffIntent },
};

/**
 * The response to an ops intent. It is a queued request, so it is never a success: nothing is refunded, restocked or
 * moved until a source receipt exists, and `receiptBackedResponse` rejects `succeeded` without one.
 */
export const opsActionResponseSchema = receiptBackedResponse.refine((r) => r.state !== "succeeded" && r.state !== "partiallySucceeded", {
  message: "An ops intent is queued for approval; it can't report success",
});
