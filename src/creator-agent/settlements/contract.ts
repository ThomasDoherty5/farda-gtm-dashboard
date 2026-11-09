import { z } from "zod";

export const settlementRef = z.string().min(1).max(4096);
export const settlementInstant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const count = z.number().int().nonnegative().safe();
// Native settlement actions currently qualify USD only; other currencies must not silently assume a minor-unit exponent.
const currency = z.literal("USD");
export const settlementScopeSchema = z.object({ workspaceId: z.string().min(1), accountId: z.string().min(1), environment: z.literal("sandbox") }).strict();
export type SettlementScope = z.infer<typeof settlementScopeSchema>;
export const settlementMoneySchema = z.object({ minorUnits: z.number().int().safe(), currency }).strict();
export const settlementReasonSchema = z.enum(["SOURCE_UNCONFIGURED", "SOURCE_UNAVAILABLE", "SOURCE_PARTIAL", "SOURCE_STALE", "NOT_OBSERVED", "NOT_APPLICABLE", "IDENTITY_UNRESOLVED", "PROVIDER_REVIEW", "PROVIDER_FAILURE", "CREATOR_ACTIVATION", "ACCOUNTING_POLICY_UNVERIFIED", "SOURCE_LINK_UNAVAILABLE", "SOURCE_LINK_EXPIRED", "J11_RECONCILIATION_UNBOUND", "J12_EXECUTION_UNBOUND", "PERMISSION_REQUIRED"]);
export function settlementFact<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), value, evidenceRef: settlementRef, observedAt: settlementInstant, reasonCode: z.null() }).strict(),
    z.object({ state: z.enum(["unknown", "notApplicable"]), value: z.null(), evidenceRef: settlementRef.nullable(), observedAt: settlementInstant.nullable(), reasonCode: settlementReasonSchema }).strict(),
  ]);
}
export const moneyFactSchema = settlementFact(settlementMoneySchema);
export const settlementStateTotalsSchema=z.object({held:moneyFactSchema,disputed:moneyFactSchema,awaitingProvider:moneyFactSchema,paid:moneyFactSchema}).strict();
export const numberFactSchema = settlementFact(z.number().finite());
export const textFactSchema = settlementFact(settlementRef);
export const settlementStateSchema = z.enum(["estimated", "earned", "held", "disputed", "approved", "billed", "awaitingCreator", "awaitingProvider", "merchantPaid", "creatorPaid", "failed", "adjusted", "reconciled", "requested", "executed", "reversed", "unknown"]);
export const balanceKeys = ["estimated", "earned", "held", "disputed", "approved", "billed", "merchantPaid", "creatorPaid", "outstanding", "adjusted"] as const;
export const balancesSchema = z.object({ estimated: moneyFactSchema, earned: moneyFactSchema, held: moneyFactSchema, disputed: moneyFactSchema,
  approved: moneyFactSchema, billed: moneyFactSchema, merchantPaid: moneyFactSchema, creatorPaid: moneyFactSchema, outstanding: moneyFactSchema, adjusted: moneyFactSchema }).strict();
export const sourceLinkSchema = z.object({ kind: z.enum(["ledger", "order", "sample", "payout", "approval", "evidence", "currentOffer"]), targetRef: settlementRef.nullable().default(null),
  state: z.enum(["verified", "missing", "expired", "denied"]), url: z.string().url().nullable(), observedAt: settlementInstant.nullable(), validUntil: settlementInstant.nullable() }).strict();
export const settlementReceiptSchema = z.object({ ref: settlementRef, componentRef: settlementRef, providerRef: settlementRef.nullable(),
  amount: settlementMoneySchema, settledAt: settlementInstant, observedAt: settlementInstant, evidenceRef: settlementRef }).strict();
export const settlementAdjustmentSchema = z.object({ ref: settlementRef, receiptRef: settlementRef, amount: settlementMoneySchema,
  effectiveAt: settlementInstant, observedAt: settlementInstant, reason: z.enum(["refund", "reversal", "correction", "chargeback"]), evidenceRef: settlementRef }).strict();
export const settlementEconomicsSchema = z.object({
  waterfall:z.object({netSales:moneyFactSchema,commerceCosts:moneyFactSchema,fixedFees:moneyFactSchema,samples:moneyFactSchema,
    netCommission:moneyFactSchema,feeEstimate:moneyFactSchema,contribution:moneyFactSchema}).strict().nullable().default(null),
  cohortRef: settlementRef, periodStart: settlementInstant, periodEnd: settlementInstant,
  eligibleOrders: numberFactSchema, grossSales: moneyFactSchema, refunds: moneyFactSchema,
  netRevenue: moneyFactSchema, creatorCommissions: moneyFactSchema, providerFees: moneyFactSchema,
  fulfillmentCost: moneyFactSchema, sampleCost: moneyFactSchema, contribution: moneyFactSchema,
}).strict();
export const settlementRecordSchema = z.object({
  ref: settlementRef, version: settlementRef, provider: z.enum(["collabs", "tiktok", "externalManual"]), accountRef: settlementRef, creatorRef: settlementRef,
  programmeRef: settlementRef, programmeVersion: settlementRef, componentRef: settlementRef, orderRef: settlementRef.nullable(), nativeRef: settlementRef.nullable(),
  currency, state: settlementStateSchema, collaborationRef: settlementRef.nullable().default(null), budgetCategory: textFactSchema.nullable().default(null), eligibleBase: moneyFactSchema, grossSales: moneyFactSchema, balances: balancesSchema,
  grossEarned:moneyFactSchema.nullable().default(null),reversed:moneyFactSchema.nullable().default(null),netAccrued:moneyFactSchema.nullable().default(null),
  commissionRatePct: numberFactSchema, fee: moneyFactSchema, feeRatePct: numberFactSchema,
  facts: z.array(z.object({ ref: settlementRef, state: settlementStateSchema, amount: settlementMoneySchema.nullable(), eventAt: settlementInstant.nullable(),
    observedAt: settlementInstant, evidenceRef: settlementRef, nativeRef: settlementRef.nullable() }).strict()).max(200),
  receipts: z.array(settlementReceiptSchema).max(100), adjustments: z.array(settlementAdjustmentSchema).max(100),
  crosswalk: z.object({ state: z.enum(["verified", "unresolved", "conflict", "unknown"]), payeeRef: settlementRef.nullable(), orderRef: settlementRef.nullable(),
    evidenceRefs: z.array(settlementRef).max(30), observedAt: settlementInstant.nullable() }).strict(),
  accounting: z.object({ state: z.enum(["unposted", "posted", "matched", "partial", "exception", "unknown"]), qboRef: settlementRef.nullable(),
    policyRef: settlementRef.nullable(), policyVersion: settlementRef.nullable(), evidenceRef: settlementRef.nullable() }).strict(),
  rates: z.array(z.object({ lane: z.enum(["standard", "shopAds"]), activePct: numberFactSchema, proposedPct: numberFactSchema,
    activeFrom: settlementInstant.nullable(), proposedFrom: settlementInstant.nullable(), termsVersion: settlementRef.nullable(),
    eligibleProducts: textFactSchema.nullish() }).strict()).max(2),
  historical: z.object({ acceptedAt: settlementInstant, termsRef: settlementRef, termsVersion: settlementRef, contractRef: settlementRef,
    invoiceRef: settlementRef, deliverableRef: settlementRef, acceptedAmount: settlementMoneySchema, payoutOwner: z.enum(["externalManual", "providerFunded"]),
    approvalRef: settlementRef.nullable(), fundingRef: settlementRef.nullable(), reviewDeadline: settlementInstant.nullable() }).strict().nullable(),
  candidates: z.array(z.object({ ref: settlementRef, statementRef: settlementRef, componentRef: settlementRef, amount: settlementMoneySchema,
    periodStart: settlementInstant, periodEnd: settlementInstant, evidenceRef: settlementRef, problem: z.enum(["duplicate", "conflict", "currency", "identity"]).nullable() }).strict()).max(100),
  samples: z.array(z.object({ ref: settlementRef, state: z.enum(["requested", "accepted", "reserved", "shipped", "delivered", "rejected", "unknown"]),
    quantity: count.nullable(), cost: moneyFactSchema, evidenceRef: settlementRef.nullable() }).strict()).max(100),
  exceptions: z.array(z.object({ ref: settlementRef, reason: settlementReasonSchema, owner: z.enum(["Finance", "Creator", "Provider", "Operations"]),
    deadline: settlementInstant.nullable(), evidenceRef: settlementRef.nullable() }).strict()).max(100),
  links: z.array(sourceLinkSchema).max(12),
}).strict();
export type SettlementRecord = z.infer<typeof settlementRecordSchema>;
export const nativeSettlementSourceSchema = z.object({ state: z.enum(["current", "partial", "stale", "unconfigured", "unavailable"]),
  observedAt: settlementInstant.nullable(), sourceUpdatedAt: settlementInstant.nullable(), validUntil: settlementInstant.nullable(),
  revision: settlementRef.nullable(), reasonCodes: z.array(settlementReasonSchema), synthetic: z.boolean() }).strict();
const common = { source: nativeSettlementSourceSchema, version: settlementRef,
  accountingPolicy: z.object({ state: z.enum(["verified", "unknown"]), reference: settlementRef.nullable() }).strict(),
  capabilities: z.object({ match: z.boolean(), export: z.boolean(), pay: z.literal(false) }).strict() };
export const nativeCommissionLedgerSchema = z.object({ kind: z.literal("native-commission-ledger"), ...common, currency: currency.nullable(),
  records: z.array(settlementRecordSchema).max(100), coverage: z.object({ returned: count, total: count.nullable(), complete: z.boolean() }).strict(),
  stateTotals:settlementStateTotalsSchema.nullable().default(null),
  economics: settlementEconomicsSchema.nullable().default(null),
  totals: z.object({ eligible: moneyFactSchema, accrued: moneyFactSchema, creatorPaid: moneyFactSchema, contribution: moneyFactSchema }).strict(),
  export: z.object({ sourceVersion: settlementRef, filters: z.object({ state: z.enum(["all", "pending", "earned", "reversed", "settled"]),
    startAt: settlementInstant, endAt: settlementInstant, timezone: z.string(), currency }).strict() }).strict().nullable(),
}).strict();
export const nativeSettlementSchema = z.object({ kind: z.literal("native-settlement"), ...common, record: settlementRecordSchema.nullable() }).strict();
export const nativePayableSchema = z.object({ kind: z.literal("native-payable"), ...common, record: settlementRecordSchema.nullable() }).strict();
export type NativeCommissionLedger = z.infer<typeof nativeCommissionLedgerSchema>;
export type NativeSettlement = z.infer<typeof nativeSettlementSchema>;
export type NativePayable = z.infer<typeof nativePayableSchema>;
export const settlementViews = ["commissionLedger", "settlementDetail", "payableDetail"] as const;
export type SettlementViewKey = typeof settlementViews[number];
export const settlementFilters = {
  commissionLedger: z.object({ provider: z.enum(["all", "collabs", "tiktok", "externalManual"]).optional(), currency: currency.optional() }).strict(),
  settlementDetail: z.object({ settlementId: settlementRef }).strict(),
  payableDetail: z.object({ payableId: settlementRef }).strict(),
} as const;
export class SettlementError extends Error {
  readonly code: string; readonly status: number; readonly executionCertainty = "notApplied" as const;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
