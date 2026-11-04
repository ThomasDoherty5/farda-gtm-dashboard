/**
 * Commission-only acquisition policy, as one pure module. Every demo service that touches terms (offer
 * save, bulk import, dispatch, approval dispatch, creator replies) asks this module, so eligibility and
 * blocker reasons cannot drift between surfaces. It is fixture evidence of the rule, not production
 * enforcement: the authenticated adapter must apply the same rule server-side (THO-283).
 *
 * A fixed amount per eligible sale is commission. A guaranteed or upfront content fee is not.
 */

export type Relationship = "commissionOnly" | "gifted" | "paid" | "hybrid";

export type AcquisitionTerms = {
  relationship: Relationship;
  upfrontFeeMinor: number;
  guaranteedFeeMinor: number;
  /** Any paid component on top of commission. */
  paidComponentMinor: number;
  commissionPct: number;
  /** Fixed amount paid per eligible sale. Allowed, and distinct from a guaranteed fee. */
  perSaleFixedMinor: number;
  /** Product and shipping are approved separately. */
  sampleCostMinor: number;
};

/** Terms as they arrive off the wire: the relationship is any string until the rule has allowed it. */
export type UntrustedTerms = Omit<AcquisitionTerms, "relationship"> & { relationship: string };

export type PolicyConfig = {
  version: string;
  maxCommissionPct: number;
  sampleCapMinor: number;
};

export const BASE_POLICY: PolicyConfig = { version: "commission-only@demo-1", maxCommissionPct: 20, sampleCapMinor: 5_000 };

/**
 * Hard limits. A policy change can't go past them, and one fixed amount per eligible sale can't either. 100,000 minor units
 * is USD 1,000, the single-commitment size that already needs a founder (adapter decision D-5).
 */
export const MAX_PER_SALE_FIXED_MINOR = 100_000;
export const POLICY_BOUNDS = { maxCommissionPct: 100, sampleCapMinor: 100_000 } as const;

export type BlockerCode =
  | "UPFRONT_FEE_PROHIBITED"
  | "GUARANTEED_FEE_PROHIBITED"
  | "PAID_COMPONENT_PROHIBITED"
  | "PAID_OR_HYBRID_PROHIBITED"
  | "GIFTED_ONLY_PROHIBITED"
  | "COMMISSION_REQUIRED"
  | "COMMISSION_ABOVE_CAP"
  | "PER_SALE_FIXED_ABOVE_CAP"
  | "RELATIONSHIP_NOT_COMMISSION_ONLY"
  | "SAMPLE_ABOVE_CAP"
  | "INVALID_AMOUNT";

export type Blocker = { code: BlockerCode; field: string; message: string };
export type Eligibility = { eligible: boolean; blockers: Blocker[]; policyVersion: string };

const MESSAGES: Record<BlockerCode, [string, string]> = {
  UPFRONT_FEE_PROHIBITED: ["upfrontFee", "New acquisition has no upfront content fee."],
  GUARANTEED_FEE_PROHIBITED: ["guaranteedFee", "New acquisition has no guaranteed or minimum content payment."],
  PAID_COMPONENT_PROHIBITED: ["paidComponent", "New acquisition has no paid component beside commission."],
  PAID_OR_HYBRID_PROHIBITED: ["relationship", "Paid and hybrid relationships can't start. They stay readable as history."],
  GIFTED_ONLY_PROHIBITED: ["relationship", "A gifted-only relationship can't start. Offer commission with a separately approved sample."],
  COMMISSION_REQUIRED: ["commission", "A per-sale commission is required."],
  COMMISSION_ABOVE_CAP: ["commission", "The commission is above what the current policy allows."],
  PER_SALE_FIXED_ABOVE_CAP: ["commission", "The fixed amount per sale is above what the policy allows."],
  RELATIONSHIP_NOT_COMMISSION_ONLY: ["relationship", "New acquisition must be commission-only. Any other relationship can't start."],
  SAMPLE_ABOVE_CAP: ["sample", "The sample cost is above the current policy cap."],
  INVALID_AMOUNT: ["amount", "Amounts must be whole, non-negative minor units."],
};

const blocker = (code: BlockerCode, extra?: string): Blocker => ({ code, field: MESSAGES[code][0], message: extra ? `${MESSAGES[code][1]} ${extra}` : MESSAGES[code][1] });

const validAmount = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** The single eligibility rule for a new acquisition offer. Never trusts a UI-computed flag. */
export function evaluateTerms(terms: UntrustedTerms, policy: PolicyConfig = BASE_POLICY): Eligibility {
  const blockers: Blocker[] = [];
  const amounts = [terms.upfrontFeeMinor, terms.guaranteedFeeMinor, terms.paidComponentMinor, terms.perSaleFixedMinor, terms.sampleCostMinor];
  if (!amounts.every(validAmount)) blockers.push(blocker("INVALID_AMOUNT"));
  if (terms.upfrontFeeMinor !== 0) blockers.push(blocker("UPFRONT_FEE_PROHIBITED"));
  if (terms.guaranteedFeeMinor !== 0) blockers.push(blocker("GUARANTEED_FEE_PROHIBITED"));
  if (terms.paidComponentMinor !== 0) blockers.push(blocker("PAID_COMPONENT_PROHIBITED"));
  // An allowlist: only commissionOnly starts. The named codes explain the known cases; anything else is refused too.
  if (terms.relationship === "paid" || terms.relationship === "hybrid") blockers.push(blocker("PAID_OR_HYBRID_PROHIBITED"));
  else if (terms.relationship === "gifted") blockers.push(blocker("GIFTED_ONLY_PROHIBITED"));
  else if (terms.relationship !== "commissionOnly") blockers.push(blocker("RELATIONSHIP_NOT_COMMISSION_ONLY"));
  const pctOk = Number.isFinite(terms.commissionPct) && terms.commissionPct > 0;
  if (!pctOk && !(terms.perSaleFixedMinor > 0)) blockers.push(blocker("COMMISSION_REQUIRED"));
  if (pctOk && terms.commissionPct > policy.maxCommissionPct) blockers.push(blocker("COMMISSION_ABOVE_CAP", `Maximum ${policy.maxCommissionPct}%.`));
  if (validAmount(terms.perSaleFixedMinor) && terms.perSaleFixedMinor > MAX_PER_SALE_FIXED_MINOR) blockers.push(blocker("PER_SALE_FIXED_ABOVE_CAP", `Maximum $${(MAX_PER_SALE_FIXED_MINOR / 100).toFixed(2)} per sale.`));
  if (validAmount(terms.sampleCostMinor) && terms.sampleCostMinor > policy.sampleCapMinor) blockers.push(blocker("SAMPLE_ABOVE_CAP"));
  return { eligible: blockers.length === 0, blockers, policyVersion: policy.version };
}

/** Blockers as the field errors the adapter error body carries. */
export function fieldErrorsOf(e: Eligibility, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of e.blockers) out[`${prefix}${b.field}`] ??= b.message;
  return out;
}

/** Terms from an approval payload (percentage commission, upfront fee, optional sample). */
export function termsFromApproval(t: { commissionRatePct: number; upfrontFee: { minorUnits: number }; sampleCost: { minorUnits: number } | null }): AcquisitionTerms {
  return { relationship: "commissionOnly", upfrontFeeMinor: t.upfrontFee.minorUnits, guaranteedFeeMinor: 0, paidComponentMinor: 0, commissionPct: t.commissionRatePct, perSaleFixedMinor: 0, sampleCostMinor: t.sampleCost?.minorUnits ?? 0 };
}

/** The only policy version an accepted historical liability carries. Matched exactly, never by prefix. */
export const HISTORICAL_LIABILITY_POLICY_VERSIONS: readonly string[] = ["historical-liability@demo"];

type ApprovalTermsShape = Parameters<typeof termsFromApproval>[0];

/**
 * Terms the dispatch guard must evaluate for an approval, or null when the approval is an accepted historical liability
 * that is paid as accepted. The exemption is deliberately narrow: an exact policy version, a founder-only approval, and a
 * pure settlement with no commission and no sample. Anything that carries new terms is evaluated like a new offer, so a
 * new fee can't ride on a historical label. (The real server must also match the amount to the accepted liability record.)
 */
export function guardTermsOf(record: { policyVersion: string; requiredRole: string; terms: ApprovalTermsShape }): AcquisitionTerms | null {
  const settlement = HISTORICAL_LIABILITY_POLICY_VERSIONS.includes(record.policyVersion) && record.requiredRole === "founder" && record.terms.commissionRatePct === 0 && record.terms.sampleCost === null;
  return settlement ? null : termsFromApproval(record.terms);
}

/**
 * A historical record is read and reconciled as it was accepted. It is never re-evaluated as a new
 * offer, and its payable is never cancelled, rewritten or suppressed by this policy.
 */
export function assessHistorical(record: { acceptedLiabilityMinor: number }) {
  return { readable: true, reconcilable: true, payableMinor: record.acceptedLiabilityMinor, newCommitmentAllowed: false, reasonCode: "HISTORICAL_TERMS_READ_ONLY" } as const;
}

/** Creating a fee commitment through the historical-payment surface is never allowed. */
export const canCreateHistoricalFeeCommitment = (): false => false;

// ---- Creator replies -------------------------------------------------------------------------------

const FEE_REQUEST = /\b(up-?front|flat[- ]?fee|guaranteed|rate[- ]?card|my rate|per (post|video|reel)|pay(ment)? (first|up ?front)|paid (post|collab|partnership)|how much (do|will|would) you pay|min(imum)? fee)\b|\$\s?\d/i;
const NEGATED = /\b(no|not|don'?t|without)\b[^.]{0,20}\b(fee|payment|upfront|up-front)\b/i;

export type ReplyRoute = {
  kind: "feeRequest" | "noFeeRequest";
  state: "termsMismatch" | "inbox";
  queue: "review" | "inbox";
  dispatchAllowed: boolean;
  autoCounterOffer: false;
  reasonCodes: string[];
  evidence: { sourceRef: string; excerpt: string };
  /** Existing suppression stays as it is; a fee request alone neither lifts nor adds it. */
  recontact: "heldForReview" | "unchanged";
};

/** A creator asking for an upfront fee is a terms mismatch for a person to review. Never an automatic counter-offer. */
export function routeCreatorReply(text: string, sourceRef: string): ReplyRoute {
  const asksFee = FEE_REQUEST.test(text) && !NEGATED.test(text);
  const evidence = { sourceRef, excerpt: text.slice(0, 280) };
  return asksFee
    ? { kind: "feeRequest", state: "termsMismatch", queue: "review", dispatchAllowed: false, autoCounterOffer: false, reasonCodes: ["TERMS_MISMATCH", "CREATOR_FEE_REQUEST"], evidence, recontact: "heldForReview" }
    : { kind: "noFeeRequest", state: "inbox", queue: "inbox", dispatchAllowed: false, autoCounterOffer: false, reasonCodes: [], evidence, recontact: "unchanged" };
}

// ---- Policy change after approval ------------------------------------------------------------------

export type TermChange = { field: string; from: string; to: string };

/** What changed between the policy an item was approved under and the policy now in force. */
export function policyChanges(approved: PolicyConfig, current: PolicyConfig): TermChange[] {
  const out: TermChange[] = [];
  if (approved.maxCommissionPct !== current.maxCommissionPct) out.push({ field: "Maximum commission", from: `${approved.maxCommissionPct}%`, to: `${current.maxCommissionPct}%` });
  if (approved.sampleCapMinor !== current.sampleCapMinor) out.push({ field: "Sample cap", from: `$${(approved.sampleCapMinor / 100).toFixed(2)}`, to: `$${(current.sampleCapMinor / 100).toFixed(2)}` });
  return out;
}

export type DispatchCheck = { ok: true } | { ok: false; reasonCodes: string[]; changes: TermChange[]; blockers: Blocker[] };

/**
 * An approval made under an older policy dispatches only if its terms still pass the policy now in force.
 * A conflicting change blocks dispatch, lists the changed terms and requires a new finite preview.
 */
export function checkApprovedDispatch(approvedUnder: PolicyConfig, current: PolicyConfig, terms: AcquisitionTerms): DispatchCheck {
  const now = evaluateTerms(terms, current);
  if (now.eligible) return { ok: true };
  const reasonCodes = approvedUnder.version === current.version ? ["POLICY_VIOLATION"] : ["POLICY_CHANGED", "NEW_PREVIEW_REQUIRED"];
  return { ok: false, reasonCodes, changes: policyChanges(approvedUnder, current), blockers: now.blockers };
}
