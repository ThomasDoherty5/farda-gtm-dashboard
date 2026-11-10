import { evaluateTerms, POLICY_BOUNDS, type PolicyConfig, type Relationship } from "../../adapter/commissionPolicy.ts";
import { commercialPolicySnapshotSchema, type CommercialPolicySnapshot, type CommercialPolicySource } from "../commercialPolicy/contract.ts";
import { evaluateCommercialTerms } from "../commercialPolicy/evaluate.ts";
import type { OfferRecord, ProviderFacts } from "../offers/contract.ts";
import type { OperationsScope } from "../operations.ts";
import {
  accountRecordSchema, capabilityReadinessSchema, type AccountRecord, type AcquisitionRequest, type ApprovedTerms, type Blocker,
  type OnboardingAction, type OnboardingInput, type PermissionRow, type PreflightRecord,
} from "./contract.ts";

/** The saved offer as the offer repository projects it. The onboarding re-reads it by ID; a caller never supplies it. */
export type OfferView = Pick<OfferRecord, "offerId" | "version" | "manifestHash" | "terms" | "state" | "ownerApprovalRef">;
/** Canonical J01 identity, as `IntakeRepository.creator` returns it. */
export type CanonicalIdentity = { creatorId: string; revision: number; suppressions: string[] };

/**
 * Trusted server bindings. Every method reads its owner's current state; nothing here comes from a request body.
 * - `capability` is the connection ledger's `requireReady` for the exact binding of one onboarding action.
 * - `account` returns the provider account record for this merchant and creator, or null when none is bound.
 */
export interface OnboardingAuthority {
  commercialPolicy: CommercialPolicySource;
  offer(offerId: string): OfferView | null;
  identity(creatorId: string): CanonicalIdentity | null;
  account(input: Pick<OnboardingInput, "merchantRef" | "creatorRef" | "providerProgram">): unknown;
  capability(action: OnboardingAction, providerAccountRef: string): unknown;
}

export const PHASE_ACTIONS: Record<"invitation" | "activation", OnboardingAction[]> = {
  invitation: ["invite"],
  activation: ["observeAcceptance", "observeLinkCode", "sandboxCheckout", "activate"],
};

/** Codes that are refused outright for new acquisition, before any account or route is considered. */
const UNCONDITIONAL = new Set(["UPFRONT_FEE_PROHIBITED", "GUARANTEED_FEE_PROHIBITED", "PAID_COMPONENT_PROHIBITED", "PAID_OR_HYBRID_PROHIBITED",
  "GIFTED_ONLY_PROHIBITED", "RELATIONSHIP_NOT_COMMISSION_ONLY", "COMMISSION_REQUIRED", "INVALID_AMOUNT", "INVALID_COMMISSION_RATE"]);
const RELATIONSHIPS: Record<string, Relationship> = { commissiononly: "commissionOnly", gifted: "gifted", giftedonly: "gifted", paid: "paid",
  hybrid: "hybrid", paidhybrid: "hybrid" };

export type ParsedRate = { rateType: ApprovedTerms["rateType"]; basisPoints: number | null; fixedMinor: number | null } | null;
/**
 * Exact commission math, or null when it is ambiguous. A percent is 1 to 100 with at most two decimals; a value under
 * 1 could be a fraction, so it is refused. A fixed amount per sale has exactly two decimals. Nothing is converted.
 */
export function parseRate(terms: Pick<ApprovedTerms, "rateType" | "rateValue">): ParsedRate {
  if (terms.rateType === "percent") {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(terms.rateValue)) return null;
    const [whole, fraction = ""] = terms.rateValue.split(".");
    const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return bps >= 100 && bps <= 10_000 ? { rateType: "percent", basisPoints: bps, fixedMinor: null } : null;
  }
  if (!/^\d{1,7}\.\d{2}$/.test(terms.rateValue)) return null;
  const minor = Number(terms.rateValue.replace(".", ""));
  return minor > 0 ? { rateType: "fixed_per_sale", basisPoints: null, fixedMinor: minor } : null;
}

const policyConfigOf = (policy: CommercialPolicySnapshot | null): PolicyConfig => policy
  ? { version: policy.version, maxCommissionPct: policy.commission.maxRateBps / 100, sampleCapMinor: policy.samples.merchandiseCapMinor + policy.samples.shippingCapMinor }
  : { version: "unavailable", maxCommissionPct: POLICY_BOUNDS.maxCommissionPct, sampleCapMinor: POLICY_BOUNDS.sampleCapMinor };

/**
 * J10-03. Screens the requested acquisition with the shared commission-only evaluator. Fees, paid-hybrid and gifted-only
 * requests are `rejected`. A separately approved product and shipping allocation is a sample cost, not a content fee;
 * an allocation without its own approval is held, never reclassified as a fee.
 */
export function screenAcquisition(request: AcquisitionRequest, terms: Pick<ApprovedTerms, "rateType" | "rateValue">, policy: CommercialPolicySnapshot | null) {
  const rate = parseRate(terms);
  const allocation = request.productAllocation;
  const eligibility = evaluateTerms({
    relationship: RELATIONSHIPS[request.relationship.toLowerCase().replace(/[^a-z]/g, "")] ?? request.relationship,
    upfrontFeeMinor: request.upfrontFeeMinor, guaranteedFeeMinor: request.guaranteedFeeMinor, paidComponentMinor: request.paidComponentMinor,
    commissionPct: rate?.basisPoints != null ? rate.basisPoints / 100 : 0, perSaleFixedMinor: rate?.fixedMinor ?? 0,
    sampleCostMinor: allocation?.approvalRef ? allocation.merchandiseMinor + allocation.shippingMinor : 0,
  }, policyConfigOf(policy));
  const codes = eligibility.blockers.map(b => b.code as string);
  const rejected = codes.filter(code => UNCONDITIONAL.has(code));
  const held = codes.filter(code => !UNCONDITIONAL.has(code));
  if (allocation && !allocation.approvalRef) held.push("PRODUCT_ALLOCATION_UNAPPROVED");
  return { rejected, held, sampleCostMinor: allocation?.approvalRef ? allocation.merchandiseMinor + allocation.shippingMinor : 0 };
}

/** A trusted source that throws is unavailable, never a pass. */
export function readSafely<T>(read: () => T): T | null { try { return read(); } catch { return null; } }
const block = (code: string, owner: Blocker["owner"], sourceRef: Blocker["sourceRef"] = null): Blocker => ({ code, owner, sourceRef });
const OFFER_RATE = { percent: "percentage", fixed_per_sale: "fixed-per-sale" } as const;

/** The account record as offer provider facts, so the shared commercial evaluator checks route, account and owners. */
function providerFactsOf(account: AccountRecord, offer: OfferView): ProviderFacts {
  return { sourceRef: account.sourceRef, observedAt: account.observedAt, validUntil: account.validUntil, provider: account.provider,
    programRef: offer.terms.programRef ?? account.sourceRef, providerAccountRef: account.providerAccountRef,
    supportsPercentage: account.commission.supportsPercent === true, supportsFixedPerSale: account.commission.supportsFixedPerSale === true,
    actualCommission: offer.terms.commission, payoutOwner: account.payoutOwnerRef, trackingOwner: account.trackingOwnerRef,
    attributionWindowDays: null, precedence: account.attributionPrecedence, conflictRule: null, holdDays: account.definitions?.holdDays ?? null,
    payoutSchedule: null, payoutThresholdMinor: null, onboarding: null, feeTreatment: null, fundingRule: null,
    refundRule: account.definitions?.refund ?? null, ...(account.recruitment ? { recruitment: account.recruitment } : {}) };
}

/** Exact agreement between the approved terms the caller named and the saved offer the server re-read. */
function termsBlockers(terms: ApprovedTerms, offer: OfferView, creatorId: string): string[] {
  const out: string[] = [];
  if (offer.terms.creatorId !== creatorId) out.push("OFFER_CREATOR_MISMATCH");
  const rate = parseRate(terms), commission = offer.terms.commission;
  if (!rate) out.push("COMMISSION_MATH_AMBIGUOUS");
  if (terms.offerVersion !== offer.version) out.push("OFFER_VERSION_CHANGED");
  if (terms.policyVersion !== offer.terms.policyVersion) out.push("APPROVED_POLICY_VERSION_MISMATCH");
  if (OFFER_RATE[terms.rateType] !== commission.type) out.push("RATE_TYPE_MISMATCH");
  else if (rate && (rate.basisPoints !== commission.standardRateBps || rate.fixedMinor !== commission.fixedMinor)) out.push("RATE_VALUE_MISMATCH");
  if (terms.eligibleBase !== commission.base) out.push("ELIGIBLE_BASE_MISMATCH");
  if (terms.currency !== commission.currency) out.push("CURRENCY_MISMATCH");
  if (offer.state === "proposed" || !offer.ownerApprovalRef) out.push("OFFER_NOT_APPROVED");
  else if (terms.approvalRef.sourceId !== offer.ownerApprovalRef) out.push("APPROVAL_REF_MISMATCH");
  if (offer.terms.checkoutRoute !== "website" || offer.terms.provider === "tiktok-shop") out.push("ROUTE_NOT_WEBSITE_AFFILIATE");
  return out;
}

const sameRef = (a: { provider: string; accountId: string; sourceId: string }, b: { provider: string; accountId: string; sourceId: string }) =>
  a.provider === b.provider && a.accountId === b.accountId && a.sourceId === b.sourceId;

export type PreflightInput = Pick<OnboardingInput, "merchantRef" | "creatorRef" | "providerProgram" | "approvedTerms" | "acquisition" | "offerId">;

/**
 * J10-01 and J10-04. Records actual merchant and creator eligibility, account plan, action permissions with their
 * connection-ledger readiness, and the quota unit and reset. Any unsupported, unverified, unknown or stale fact blocks:
 * a preflight reports `ready` only when every required fact is known and passes. Unknown quota is never zero.
 */
export function runPreflight(input: PreflightInput, authority: OnboardingAuthority, scope: OperationsScope, now: number,
  phase: "invitation" | "activation" = "invitation"): PreflightRecord {
  const blockers: Blocker[] = [];
  const checkedAt = new Date(now).toISOString();
  const policyRead = commercialPolicySnapshotSchema.safeParse(readSafely(() => authority.commercialPolicy.readCurrent({ ...scope })));
  let policy: CommercialPolicySnapshot | null = policyRead.success ? policyRead.data : null;
  if (!policy) blockers.push(block("COMMERCIAL_POLICY_UNAVAILABLE", "policy-owner"));
  else if (policy.scope.workspaceId !== scope.workspaceId || policy.scope.accountId !== scope.accountId) { blockers.push(block("COMMERCIAL_POLICY_SCOPE_MISMATCH", "policy-owner")); policy = null; }
  else if (policy.state !== "effective") blockers.push(block("COMMERCIAL_POLICY_NOT_EFFECTIVE", "policy-owner"));
  else if (Date.parse(policy.observedAt) > now || Date.parse(policy.validUntil) <= now) blockers.push(block("COMMERCIAL_POLICY_STALE", "policy-owner"));

  const screen = screenAcquisition(input.acquisition, input.approvedTerms, policy);
  for (const code of [...screen.rejected, ...screen.held]) blockers.push(block(code, "policy-owner"));

  const offer: OfferView | null = readSafely(() => authority.offer(input.offerId));
  if (!offer) blockers.push(block("OFFER_UNAVAILABLE", "operator"));
  else for (const code of termsBlockers(input.approvedTerms, offer, input.creatorRef.sourceId)) blockers.push(block(code, code === "COMMISSION_MATH_AMBIGUOUS" ? "policy-owner" : "operator"));

  const accountRead = accountRecordSchema.safeParse(readSafely(() => authority.account({ merchantRef: input.merchantRef, creatorRef: input.creatorRef, providerProgram: input.providerProgram })));
  const account: AccountRecord | null = accountRead.success ? accountRead.data : null;
  const permissions: PermissionRow[] = [];
  let validUntil: number | null = null;
  const bound = (until: string | null | undefined) => { if (until) { const t = Date.parse(until); validUntil = validUntil === null ? t : Math.min(validUntil, t); } };
  if (policy) bound(policy.validUntil);

  if (!account) blockers.push(block("PROVIDER_ACCOUNT_UNVERIFIED", "operator"));
  else {
    // A source or fixture record from another merchant, creator or provider is a cross-account payload.
    if (!sameRef(account.merchantRef, input.merchantRef) || !sameRef(account.creatorRef, input.creatorRef) || account.provider !== input.providerProgram.provider)
      blockers.push(block("ACCOUNT_SCOPE_MISMATCH", "operator"));
    if (account.origin === "synthetic" && scope.environment !== "sandbox") blockers.push(block("SYNTHETIC_ACCOUNT_OUTSIDE_SANDBOX", "operator"));
    if (Date.parse(account.observedAt) > now || Date.parse(account.validUntil) <= now) blockers.push(block("PROVIDER_ACCOUNT_STALE", "provider"));
    bound(account.validUntil);
    const source = (sourceId: string | null) => sourceId ? { provider: account!.provider, accountId: account!.providerAccountRef, sourceId, url: null } : null;
    if (account.plan.name === null) blockers.push(block("ACCOUNT_PLAN_UNKNOWN", "merchant"));
    for (const [who, verdict] of [["MERCHANT", account.merchantEligibility], ["CREATOR", account.creatorEligibility]] as const) {
      if (verdict.state !== "eligible") blockers.push(block(`${who}_${verdict.state === "ineligible" ? "INELIGIBLE" : "ELIGIBILITY_UNKNOWN"}`,
        who === "MERCHANT" ? "merchant" : "creator", source(verdict.sourceRef)));
    }
    if (account.quota.state === "unknown") blockers.push(block("QUOTA_UNKNOWN", "provider"));
    else if (Date.parse(account.quota.resetAt) <= now) blockers.push(block("QUOTA_STALE", "provider", source(account.quota.sourceRef)));
    else if (phase === "invitation" && account.quota.remaining < 1) blockers.push(block("QUOTA_EXHAUSTED", "provider", source(account.quota.sourceRef)));
    if (!account.definitions) blockers.push(block("PROVIDER_DEFINITIONS_UNKNOWN", "provider"));
    if (offer) {
      // J10-04: supported by the chosen provider and the current account, never silently converted.
      const type = input.approvedTerms.rateType;
      const support = type === "percent" ? account.commission.supportsPercent : account.commission.supportsFixedPerSale;
      if (support === null) blockers.push(block("COMMISSION_SUPPORT_UNKNOWN", "provider", source(account.commission.sourceRef)));
      else if (!support) blockers.push(block(type === "percent" ? "PERCENT_COMMISSION_UNSUPPORTED" : "FIXED_PER_SALE_UNSUPPORTED", "provider", source(account.commission.sourceRef)));
      if (!account.commission.eligibleBases.includes(input.approvedTerms.eligibleBase)) blockers.push(block("ELIGIBLE_BASE_UNSUPPORTED", "provider", source(account.commission.sourceRef)));
      if (!account.commission.currencies.includes(input.approvedTerms.currency)) blockers.push(block("CURRENCY_UNSUPPORTED", "provider", source(account.commission.sourceRef)));
      if (policy) for (const code of evaluateCommercialTerms(offer.terms, policy, providerFactsOf(account, offer), now)) blockers.push(block(code, "policy-owner"));
    }
    for (const action of PHASE_ACTIONS[phase]) {
      const provider = account.permissions.find(row => row.action === action)?.state ?? "unknown";
      const parsed = capabilityReadinessSchema.safeParse(readSafely(() => authority.capability(action, account.providerAccountRef)));
      const readiness = parsed.success ? parsed.data : null;
      const capability = readiness?.state ?? "Unverified";
      const fresh = !!readiness?.expiresAt && Date.parse(readiness.expiresAt) > now;
      const ready = provider === "granted" && !!readiness?.allowed && capability === "Ready" && fresh;
      permissions.push({ action, provider, capability, capabilityReceiptRef: readiness?.receiptRef ?? null, ready });
      const name = action.replace(/[A-Z]/g, c => "_" + c).toUpperCase();
      if (provider !== "granted") blockers.push(block(`${name}_PERMISSION_${provider === "denied" ? "DENIED" : "UNKNOWN"}`, "merchant"));
      if (capability !== "Ready" || !readiness?.allowed) blockers.push(block(`${name}_CAPABILITY_${capability.toUpperCase()}`, "operator"));
      else if (!fresh) blockers.push(block(`${name}_CAPABILITY_EXPIRED`, "operator"));
      if (readiness?.expiresAt) bound(readiness.expiresAt);
    }
  }
  const unique = [...new Map(blockers.map(b => [b.code, b])).values()];
  const rate = parseRate(input.approvedTerms);
  return { state: unique.length ? "blocked" : "ready", origin: account?.origin ?? null, checkedAt,
    validUntil: validUntil === null ? null : new Date(validUntil).toISOString(), providerAccountRef: account?.providerAccountRef ?? null,
    plan: account?.plan ?? null, merchantEligibility: account?.merchantEligibility ?? null, creatorEligibility: account?.creatorEligibility ?? null,
    permissions, quota: account?.quota ?? null, definitions: account?.definitions ?? null, attributionPrecedence: account?.attributionPrecedence ?? "unknown",
    commission: rate, policyVersion: policy?.version ?? null, offerVersion: offer?.version ?? null, manifestHash: offer?.manifestHash ?? null, blockers: unique };
}
