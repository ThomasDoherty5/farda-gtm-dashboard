import { z } from "zod";

/** Public semantic codes only. Source text, locators and grants never enter this view. */
export const commercialEligibilityReasonCodes = [
  "OFFER_SELECTION_REQUIRED", "OFFER_VERSION_REQUIRED", "OFFER_VERSION_MISMATCH", "OFFER_NOT_FOUND",
  "ASSESSMENT_BASIS_REQUIRED", "ASSESSMENT_BASIS_STALE", "ASSESSMENT_BASIS_MISMATCH", "COMMERCIAL_SOURCE_HELD",
  "COMMERCIAL_POLICY_UNAVAILABLE", "COMMERCIAL_POLICY_UNVERIFIED", "COMMERCIAL_POLICY_SOURCE_HELD",
  "COMMERCIAL_POLICY_PROPOSED", "COMMERCIAL_POLICY_REVOKED", "COMMERCIAL_POLICY_NOT_EFFECTIVE",
  "COMMERCIAL_POLICY_CHANGED", "COMMERCIAL_PRICING_CHANGED", "NEW_PREVIEW_REQUIRED",
  "COMMERCIAL_ROUTE_UNSUPPORTED", "COMMISSION_ROUTE_UNSUPPORTED", "PER_SALE_FIXED_ABOVE_CAP",
  "PROVIDER_ACCOUNT_UNVERIFIED", "PROVIDER_PAYOUT_OWNER_MISMATCH", "PROVIDER_ATTRIBUTION_OWNER_MISMATCH",
  "SOCIAL_CAT_AFFILIATE_SOURCE_UNVERIFIED", "PRODUCT_AND_SHIPPING_REQUIRED", "SAMPLE_POLICY_HELD",
  "CLAIM_POLICY_UNVERIFIED", "DISCLOSURE_POLICY_UNVERIFIED", "PRICE_BUNDLE_UNAVAILABLE",
  "PERFORMANCE_REWARD_VERSION_MISMATCH", "PERFORMANCE_REWARD_PROPOSED", "PERFORMANCE_REWARD_PROGRAMME_PAUSED",
  "PERFORMANCE_REWARD_UNVERIFIED", "PERFORMANCE_REWARD_NOT_EFFECTIVE", "PERFORMANCE_REWARD_SOURCE_HELD",
  "CREATOR_FEE_REQUEST", "CREATOR_SUPPRESSED", "SUPPRESSION_UNVERIFIED", "CURRENT_INVITATION_SCORECARD_REQUIRED",
  "OFFER_ECONOMICS_HELD", "SOURCE_ACCEPTANCE_REQUIRED", "OFFER_SOURCE_FENCE_UNAVAILABLE", "OFFER_SOURCE_EXPIRED",
  "UPFRONT_FEE_PROHIBITED", "GUARANTEED_FEE_PROHIBITED", "PAID_COMPONENT_PROHIBITED", "PAID_OR_HYBRID_PROHIBITED",
  "GIFTED_ONLY_PROHIBITED", "COMMISSION_REQUIRED", "COMMISSION_ABOVE_CAP", "RELATIONSHIP_NOT_COMMISSION_ONLY",
  "SAMPLE_ABOVE_CAP", "INVALID_COMMISSION_RATE", "INVALID_AMOUNT",
] as const;
export const commercialEligibilityReasonSchema = z.enum(commercialEligibilityReasonCodes);
export type CommercialEligibilityReason = z.infer<typeof commercialEligibilityReasonSchema>;
const alias = (purpose: string) => z.string().regex(new RegExp(`^commercial-${purpose}-[a-f0-9]{64}$`));
const version = z.string().regex(/^v[1-9]\d*$/);

/** Display aliases cannot be decoded or submitted as offer selections or release authority. */
export const commercialEligibilityViewSchema = z.object({
  kind: z.literal("commercial-eligibility"),
  selected: z.object({ offerRef: alias("offer"), version: version.nullable() }).strict().nullable(),
  phase: z.enum(["invitation", "activation", "shipment"]),
  state: z.enum(["eligible", "held", "unbound"]),
  reasonCodes: z.array(commercialEligibilityReasonSchema).max(commercialEligibilityReasonCodes.length),
  basisStatus: z.enum(["current", "missing", "stale", "mismatch", "notSelected"]),
  policyVersion: alias("policy").nullable(),
  modelVersion: alias("model").nullable(),
  configVersion: alias("config").nullable(),
  rewardBasis: z.enum(["verified", "notApplicable", "unknown"]),
  rewardVersion: alias("reward").nullable(),
  basisHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  validity: z.object({ observedAt: z.string().datetime({offset:true}), validUntil: z.string().datetime({offset:true}) }).strict()
    .refine(value=>Number.isFinite(Date.parse(value.observedAt))&&Date.parse(value.validUntil)>Date.parse(value.observedAt),"A finite source validity interval is required.").optional(),
  confersApproval: z.literal(false),
  sourceEffect: z.literal("none"),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.reasonCodes).size !== value.reasonCodes.length) ctx.addIssue({ code: "custom", message: "Reason codes must be distinct." });
  if (value.state === "eligible" && (!value.selected?.version || value.basisStatus !== "current" || value.reasonCodes.length ||
    !value.policyVersion || !value.modelVersion || !value.configVersion || !value.basisHash || value.rewardBasis === "unknown"))
    ctx.addIssue({ code: "custom", message: "Eligibility requires an exact current commercial basis." });
  if (value.state !== "eligible" && !value.reasonCodes.length) ctx.addIssue({ code: "custom", message: "A held selection needs a reason." });
  if ((value.state === "unbound") !== (value.selected === null)) ctx.addIssue({ code: "custom", message: "Unbound views have no selected offer." });
  if ((value.rewardBasis === "verified") !== (value.rewardVersion !== null)) ctx.addIssue({ code: "custom", message: "Reward versions need verified reward evidence." });
});
export type CommercialEligibilityView = z.infer<typeof commercialEligibilityViewSchema>;
