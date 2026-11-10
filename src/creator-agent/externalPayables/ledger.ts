import { digest } from "../config.ts";
import { sourceMethods, type Adjustment, type CommissionPolicyObservation, type LiabilityReason, type LiabilitySource, type Money, type Ref,
  type SettlementReceipt, type StoredLiability } from "./contract.ts";

/** Pure liability rules. No clock, database or provider here; callers pass what they read inside their lock. */
export const refKey = (ref: Ref) => `${ref.provider}|${ref.accountId}|${ref.sourceId}`;
export const liabilityVersion = (source: LiabilitySource) => `liability-v:${digest(materialOf(source))}`;
/** The material a payment is bound to. Observation times and leases are excluded so a re-read of unchanged facts is the same version. */
export function materialOf(s: LiabilitySource) {
  return { liabilityRef: s.liabilityRef, payee: s.payee, payoutOwner: s.payoutOwner, componentKind: s.componentKind, acceptedObligation: s.acceptedObligation,
    acceptedAmount: s.acceptedAmount, invoiceRef: s.invoiceRef, amount: s.amount, deliverableRef: s.deliverableRef, route: s.route,
    evidence: Object.fromEntries(Object.entries(s.evidence).map(([k, e]) => [k, { ref: e.ref, method: e.method, value: e.value, unknownReason: e.unknownReason }])),
    priorPayments: [...s.priorPayments].sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref))) };
}
/** Basis changes that withdraw a live payment: amount, payee, terms, component or route. */
export function paymentBasis(s: LiabilitySource) {
  return { payee: s.payee, amount: s.amount, acceptedAmount: s.acceptedAmount, acceptedObligation: s.acceptedObligation, componentKind: s.componentKind,
    payoutOwner: s.payoutOwner, invoiceRef: s.invoiceRef, route: s.route };
}

/** Exact sum in one currency. Returns null on a mixed currency or an unsafe total; an unknown is never zero. */
export function sum(currency: string, values: readonly Money[]): number | null {
  let total = 0n;
  for (const value of values) { if (value.currency !== currency) return null; total += BigInt(value.minorUnits); }
  return total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(total);
}

/**
 * Outstanding = invoice amount - (source prior payments and our settled receipts, each counted once) + adjustments returned against our receipts.
 * Null when any currency differs.
 */
export function computeOutstanding(source: LiabilitySource, receipts: readonly SettlementReceipt[], adjustments: readonly Adjustment[]): Money | null {
  const currency = source.amount.currency, paid = new Map<string, Money>();
  for (const prior of source.priorPayments) paid.set(prior.ref.sourceId, prior.amount);
  for (const receipt of receipts) paid.set(receipt.receiptRef, receipt.amount);
  const paidMinor = sum(currency, [...paid.values()]), returned = sum(currency, adjustments.map(a => a.amount));
  if (paidMinor === null || returned === null) return null;
  const minor = BigInt(source.amount.minorUnits) - BigInt(paidMinor) + BigInt(returned);
  return Number.isSafeInteger(Number(minor)) ? { minorUnits: Number(minor), currency } : null;
}

export type EligibilityContext = { policy: CommissionPolicyObservation; now: number; others: readonly StoredLiability[];
  receipts: readonly SettlementReceipt[]; adjustments: readonly Adjustment[] };
/** J12-01..03. Classification uses the source facts, never the `label` or `origin`. */
export function evaluateLiability(s: LiabilitySource, ctx: EligibilityContext): LiabilityReason[] {
  const reasons = new Set<LiabilityReason>();
  if (Date.parse(s.observedAt) > ctx.now || Date.parse(s.validUntil) <= ctx.now) reasons.add("SOURCE_STALE");
  if (ctx.policy.state !== "effective") reasons.add("COMMISSION_POLICY_UNKNOWN");
  else if (Date.parse(s.acceptedObligation.acceptedAt) >= Date.parse(ctx.policy.effectiveAt)) reasons.add("ACCEPTED_AFTER_COMMISSION_ONLY");
  if (s.componentKind === "minimumGuarantee" || s.componentKind === "paidHybrid") reasons.add("NEW_ACQUISITION_FEE_PROHIBITED");
  if (s.componentKind === "commission" || s.payoutOwner !== "external_manual") reasons.add("NATIVE_SETTLEMENT_EXCLUDED");
  const { contract, invoice, deliverable, balance } = s.evidence;
  if (Object.values(s.evidence).some(e => !(sourceMethods as readonly string[]).includes(e.method))) reasons.add("EVIDENCE_UNVERIFIED");
  if (refKey(contract.ref) !== refKey(s.acceptedObligation.contractRef) || contract.value?.state !== "accepted" || contract.value.acceptedAt !== s.acceptedObligation.acceptedAt)
    reasons.add("CONTRACT_EVIDENCE_REQUIRED");
  if (refKey(deliverable.ref) !== refKey(s.deliverableRef) || deliverable.value?.state !== "accepted") reasons.add("DELIVERABLE_EVIDENCE_REQUIRED");
  if (refKey(invoice.ref) !== refKey(s.invoiceRef) || !invoice.value || invoice.value.state === "void") reasons.add("INVOICE_EVIDENCE_REQUIRED");
  else if (invoice.value.state === "paid") reasons.add("COMPONENT_ALREADY_SETTLED");
  const currency = s.amount.currency;
  const currencies = [s.acceptedAmount, ...(invoice.value ? [invoice.value.amount] : []), ...(balance.value ? [balance.value] : []),
    ...s.priorPayments.map(p => p.amount), ...ctx.receipts.map(r => r.amount), ...ctx.adjustments.map(a => a.amount)];
  if (currencies.some(m => m.currency !== currency)) reasons.add("CURRENCY_MISMATCH");
  else {
    if (s.amount.minorUnits > s.acceptedAmount.minorUnits) reasons.add("FEE_INCREASED");
    if (s.amount.minorUnits <= 0) reasons.add("INVOICE_EVIDENCE_REQUIRED");
    if (invoice.value && invoice.value.amount.minorUnits !== s.amount.minorUnits) reasons.add("INVOICE_EVIDENCE_REQUIRED");
    const outstanding = computeOutstanding(s, ctx.receipts, ctx.adjustments);
    if (!balance.value) reasons.add("BALANCE_UNKNOWN");
    else if (!outstanding || outstanding.minorUnits !== balance.value.minorUnits) reasons.add("BALANCE_MISMATCH");
    if (outstanding && outstanding.minorUnits <= 0) reasons.add("COMPONENT_ALREADY_SETTLED");
  }
  for (const other of ctx.others) {
    if (other.liabilityRef === s.liabilityRef) continue;
    if (refKey(other.source.invoiceRef) === refKey(s.invoiceRef)) reasons.add("DUPLICATE_INVOICE");
    if (refKey(other.source.acceptedObligation.contractRef) === refKey(s.acceptedObligation.contractRef) &&
      other.source.acceptedObligation.componentKey === s.acceptedObligation.componentKey) reasons.add("DUPLICATE_COMPONENT");
  }
  return [...reasons].sort();
}
