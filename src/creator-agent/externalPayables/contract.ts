import { z } from "zod";
import { approvalRefSchema } from "../approvals/contract.ts";
import { settlementReasonSchema } from "../settlements/contract.ts";

/**
 * J12: settlement of existing, already-accepted external fixed-fee liabilities. Nothing here creates a new acquisition fee.
 * Normalized internal types, not provider API fields. Money is integer minor units in one ISO 4217 currency.
 */
const text = z.string().min(1).max(240);
export const instantSchema = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)), "A finite timestamp is required.");
export const refSchema = z.object({ provider: text, accountId: text, sourceId: text, url: z.string().url().startsWith("https://").max(2048).nullable() }).strict();
export type Ref = z.infer<typeof refSchema>;
export const moneySchema = z.object({ minorUnits: z.number().int().safe(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export type Money = z.infer<typeof moneySchema>;
/** Observation methods a trusted server source reader may report. A UI import is never source evidence. */
export const sourceMethods = ["api", "export", "authorizedBrowser"] as const;
export function evidenceSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({ ref: refSchema, observedAt: instantSchema, sourceUpdatedAt: instantSchema.nullable(), method: z.enum([...sourceMethods, "uiImport", "manual"]),
    value: value.nullable(), unknownReason: z.string().min(1).max(200).nullable() }).strict()
    .refine(e => (e.value === null) !== (e.unknownReason === null), "Evidence has either a value or an explicit unknown reason.");
}
/** Only an accepted fixed content fee is payable here. Guarantees and paid-hybrid terms are never historical-safe; commissions settle natively. */
export const componentKinds = ["fixedContentFee", "commission", "minimumGuarantee", "paidHybrid"] as const;
export const payoutOwners = ["external_manual", "provider_native", "provider_funded"] as const;

/** One source observation of a historical liability, read by the trusted server source reader. `label` and `origin` are never trusted. */
export const liabilitySourceSchema = z.object({
  liabilityRef: approvalRefSchema,
  origin: z.enum(["source", "uiImport"]),
  label: z.string().max(60).nullable(),
  payee: z.object({ ref: refSchema, version: approvalRefSchema }).strict(),
  payoutOwner: z.enum(payoutOwners),
  componentKind: z.enum(componentKinds),
  acceptedObligation: z.object({ contractRef: refSchema, acceptedAt: instantSchema, termsVersion: approvalRefSchema, componentKey: approvalRefSchema }).strict(),
  acceptedAmount: moneySchema,
  invoiceRef: refSchema,
  amount: moneySchema,
  deliverableRef: refSchema,
  route: z.object({ routeRef: approvalRefSchema, version: approvalRefSchema, account: refSchema }).strict(),
  evidence: z.object({
    contract: evidenceSchema(z.object({ state: z.enum(["accepted", "pending", "terminated"]), acceptedAt: instantSchema }).strict()),
    invoice: evidenceSchema(z.object({ state: z.enum(["open", "paid", "void"]), amount: moneySchema }).strict()),
    deliverable: evidenceSchema(z.object({ state: z.enum(["accepted", "pending", "rejected"]) }).strict()),
    balance: evidenceSchema(moneySchema),
  }).strict(),
  priorPayments: z.array(z.object({ ref: refSchema, amount: moneySchema }).strict()).max(50),
  observedAt: instantSchema, validUntil: instantSchema,
}).strict();
export type LiabilitySource = z.infer<typeof liabilitySourceSchema>;

/** THO-284 commission-only policy as the server observes it. Unknown blocks; it is never assumed. */
export type CommissionPolicyObservation = { state: "effective"; policyVersion: string; effectiveAt: string } | { state: "unknown"; reason: string };

export const liabilityReasons = [
  "COMMISSION_POLICY_UNKNOWN", "ACCEPTED_AFTER_COMMISSION_ONLY", "NEW_ACQUISITION_FEE_PROHIBITED", "FEE_INCREASED", "NATIVE_SETTLEMENT_EXCLUDED",
  "CONTRACT_EVIDENCE_REQUIRED", "INVOICE_EVIDENCE_REQUIRED", "DELIVERABLE_EVIDENCE_REQUIRED", "BALANCE_UNKNOWN", "BALANCE_MISMATCH",
  "EVIDENCE_UNVERIFIED", "CURRENCY_MISMATCH", "DUPLICATE_INVOICE", "DUPLICATE_COMPONENT", "COMPONENT_ALREADY_SETTLED", "SOURCE_STALE",
] as const;
export type LiabilityReason = typeof liabilityReasons[number];

export type StoredLiability = { liabilityRef: string; version: string; source: LiabilitySource; eligible: boolean; reasons: LiabilityReason[]; recordedAt: string };

export const intentStates = ["proposed", "reserved", "submitting", "submitted", "uncertain", "settled", "partial", "failed", "withdrawn"] as const;
export type IntentState = typeof intentStates[number];
/** Live: a payment may already be at the provider, or is about to be. A change to its basis withdraws it and opens a blocking conflict. */
export const LIVE_STATES: readonly IntentState[] = ["proposed", "reserved", "submitting", "submitted", "uncertain"];
export type PaymentIntent = {
  intentRef: string; version: number; liabilityRef: string; liabilityVersion: string;
  /** Digest of the payment basis (payee, amounts, obligation, route). Approval binds this, so an unrelated evidence refresh does not void it. */
  basisVersion: string; state: IntentState; reasonCode: string | null;
  payee: LiabilitySource["payee"]; amount: Money; componentKey: string; termsVersion: string; route: LiabilitySource["route"]; policyVersion: string;
  /** Provider idempotency key. Every caller, retry and executor channel for this intent uses exactly this key. */
  providerKey: string; submissionRef: string | null; createdAt: string; updatedAt: string; reservedAt: string | null;
};
export type PaymentAttempt = { intentRef: string; attemptNumber: number; attemptRef: string; channel: ExecutorChannel; startedAt: string; deadlineAt: string;
  outcome: "open" | "accepted" | "rejected" | "unknown" | "notApplied" };
export type SettlementReceipt = { receiptRef: string; intentRef: string; liabilityRef: string; submissionRef: string; amount: Money; settledAt: string; observedAt: string };
export const adjustmentSchema = z.object({ adjustmentRef: approvalRefSchema, receiptRef: approvalRefSchema, amount: moneySchema,
  kind: z.enum(["reversal", "refund", "returned"]), effectiveAt: instantSchema, evidence: refSchema }).strict()
  .refine(a => a.amount.minorUnits > 0, "An adjustment amount is positive; its kind gives the direction.");
export type Adjustment = z.infer<typeof adjustmentSchema>;
export type Conflict = { conflictRef: string; liabilityRef: string; intentRef: string | null; kind: "basisChanged" | "lateOutcome" | "overSettlement" | "currencyMismatch" | "receiptIdentity";
  blocking: boolean; state: "open" | "resolved"; detail: Record<string, unknown>; createdAt: string; resolvedAt: string | null; resolvedBy: string | null };

/** Executor channels share one provider key. The approved payment route is separate and material. */
export type ExecutorChannel = "api" | "authorizedBrowser";
export type SubmitRequest = { providerKey: string; payee: Ref; payeeVersion: string; amount: Money; routeRef: string; routeVersion: string; deadline: string; channel: ExecutorChannel };
export const submitResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("accepted"), providerKey: text, submissionRef: approvalRefSchema, acceptedAt: instantSchema }).strict(),
  z.object({ state: z.literal("rejected"), providerKey: text, reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/) }).strict(),
]);
export type SubmitResult = z.infer<typeof submitResultSchema>;
export const lookupResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), providerKey: text, submissionRef: approvalRefSchema, status: z.enum(["pending", "settled", "partial", "failed"]),
    settlements: z.array(z.object({ receiptRef: approvalRefSchema, amount: moneySchema, settledAt: instantSchema }).strict()).max(50),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).nullable(), observedAt: instantSchema }).strict(),
  z.object({ state: z.literal("notFound"), providerKey: text, complete: z.literal(true), observedAt: instantSchema }).strict(),
  z.object({ state: z.literal("unknown"), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/) }).strict(),
]);
export type LookupResult = z.infer<typeof lookupResultSchema>;
/**
 * Injected payment provider. No real adapter exists in this module. `submit` must be idempotent on `providerKey` across channels
 * and must not apply after `deadline`; a thrown error or timeout is an unknown outcome. `lookup` reads by the same key, bypassing caches.
 */
export interface PaymentProvider { readonly maxSubmitMs: number; submit(request: SubmitRequest): Promise<unknown>; lookup(providerKey: string): Promise<unknown> }
/** Trusted server reader for the current liability source. */
export interface LiabilitySourceReader { read(liabilityRef: string): Promise<unknown> }

/** Owner-adopted accounting policy. There is no default; until one is adopted, matching returns ACCOUNTING_POLICY_UNVERIFIED. */
export const accountingPolicySchema = z.object({ policyRef: approvalRefSchema, version: approvalRefSchema, adoptedBy: approvalRefSchema, adoptedAt: instantSchema,
  documentRef: refSchema, mapping: z.object({ expenseAccount: refSchema, liabilityAccount: refSchema, cashAccount: refSchema }).strict() }).strict();
export type AccountingPolicy = z.infer<typeof accountingPolicySchema>;
export const statementSchema = z.object({ statementRef: approvalRefSchema, account: refSchema, observedAt: instantSchema,
  lines: z.array(z.object({ lineRef: approvalRefSchema, direction: z.enum(["outflow", "inflow"]), amount: moneySchema, postedAt: instantSchema,
    reference: approvalRefSchema.nullable() }).strict()).min(1).max(500) }).strict();
export type Statement = z.infer<typeof statementSchema>;
export type AccountingMatch = { matchRef: string; receiptRef: string; liabilityRef: string; statementRef: string; lineRef: string; amount: Money;
  policyRef: string; policyVersion: string; mapping: AccountingPolicy["mapping"]; matchedAt: string };

export type PaymentState = "blocked" | "approved" | "submitted" | "uncertain" | "failed" | "partial" | "settled";
/** The ticket's output shape for one liability. */
export type PayableStatus = { liabilityRef: string; submissionRef: string | null; settlementReceipt: string | null; outstandingBalance: Money | null;
  accountingMatch: string | null; paymentState: PaymentState; exceptionReason: string | null };

export const ACCOUNTING_POLICY_UNVERIFIED = settlementReasonSchema.enum.ACCOUNTING_POLICY_UNVERIFIED;
export const EXTERNAL_PAYABLE_ACTION = "externalPayable.settleHistorical";
export const EXTERNAL_PAYABLE_HANDLER = "external-payable-settle.v1";

export class ExternalPayableError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 409) { super(code); this.name = "ExternalPayableError"; this.code = code; this.status = status; }
}
