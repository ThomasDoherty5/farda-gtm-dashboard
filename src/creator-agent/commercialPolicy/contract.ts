import { z } from "zod";

export const commercialRef = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine(value => !value.includes("://"), "Use an opaque reference.");
export const commercialInstant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "A finite timestamp is required.");
export const commercialMinor = z.number().int().nonnegative().safe();
export const commercialScopeSchema = z.object({ workspaceId: commercialRef, accountId: commercialRef, environment: z.literal("sandbox") }).strict();
export type CommercialScope = z.infer<typeof commercialScopeSchema>;
const milestone = z.enum(["tech", "phone", "vacation"]);
export const rewardOptionSchema = z.object({ optionId: commercialRef, milestone, kind: z.enum(["item", "allowance", "trip"]),
  label: z.string().min(1).max(120), providerRef: commercialRef,
  deliveryRoute: z.enum(["provider-direct", "farda-physical", "allowance-transfer", "booking"]) }).strict();
export const performanceRewardTermsSchema = z.object({ state: z.enum(["proposed", "effective"]), adoptionRef: commercialRef.nullable(),
  effectiveAt: commercialInstant.nullable(), fundingRef: commercialRef.nullable(), economicsRef: commercialRef.nullable(),
  conditionsRef: commercialRef, currency: z.literal("USD"), base: z.literal("matured-retained-eligible-merchandise"),
  allInCaps: z.literal(true), preservesEarnedObligations: z.literal(true),
  milestones: z.array(z.object({ milestone, thresholdMinor: commercialMinor.positive(), additionalCapMinor: commercialMinor.positive() }).strict()).min(1).max(3),
  options: z.array(rewardOptionSchema).max(50),
}).strict().superRefine((value, ctx) => {
  if (value.state === "effective" && (!value.adoptionRef || !value.effectiveAt || !value.fundingRef || !value.economicsRef))
    ctx.addIssue({ code: "custom", message: "Effective reward terms require adoption, funding and economics provenance." });
  if (new Set(value.milestones.map(row => row.milestone)).size !== value.milestones.length || new Set(value.options.map(row => row.optionId)).size !== value.options.length)
    ctx.addIssue({ code: "custom", message: "Reward milestones and options must be unique." });
  if (value.options.some(option => !value.milestones.some(row => row.milestone === option.milestone)))
    ctx.addIssue({ code: "custom", message: "Every option must belong to an exact programme milestone." });
});

/** Exact historical programme terms, separately from current permission to execute an earned reward. */
export const rewardPolicySnapshotSchema = z.object({ scope: commercialScopeSchema, programmeRef: commercialRef, rewardVersion: commercialRef,
  sourceRef: commercialRef, sourceVersion: commercialRef, observedAt: commercialInstant, validUntil: commercialInstant,
  terms: performanceRewardTermsSchema, pausedForNewAcquisition: z.boolean(),
  execution: z.object({ state: z.enum(["permitted", "unverified", "denied"]), permissionRef: commercialRef.nullable(), sourceVersion: commercialRef,
    observedAt: commercialInstant, validUntil: commercialInstant }).strict(),
}).strict().superRefine((value,ctx)=>{
  if(value.execution.state==="permitted" && !value.execution.permissionRef)ctx.addIssue({code:"custom",message:"Permitted reward execution requires its source permission reference."});
  if(Date.parse(value.validUntil)<=Date.parse(value.observedAt) || Date.parse(value.execution.validUntil)<=Date.parse(value.execution.observedAt))ctx.addIssue({code:"custom",message:"Reward source leases must have positive duration."});
});
export type RewardPolicySnapshot = z.infer<typeof rewardPolicySnapshotSchema>;

export const commercialRouteSchema = z.object({ recruitmentSource: commercialRef, publishingNetwork: commercialRef,
  checkoutRoute: z.enum(["website", "tiktok-shop"]), provider: z.enum(["shopify-collabs", "tiktok-shop", "external-affiliate"]),
  providerAccountRef:commercialRef,
  collaboration: z.literal("affiliate"), attributionOwnerRef: commercialRef, payoutOwnerRef: commercialRef,
  supportsPercentage: z.boolean(), supportsFixedPerSale: z.boolean(), productAndShippingRequired: z.boolean() }).strict();
export const commercialPolicySnapshotSchema = z.object({ scope: commercialScopeSchema, policyId: commercialRef, version: commercialRef,
  sourceRef: commercialRef, sourceVersion: commercialRef, ownerRef: commercialRef, observedAt: commercialInstant, validUntil: commercialInstant,
  state: z.enum(["proposed", "effective", "revoked"]), effectiveAt: commercialInstant.nullable(), approvalRef: commercialRef.nullable(),
  compensation: z.literal("commission-only"), currency: z.literal("USD"),
  commission: z.object({ version: commercialRef, maxRateBps: z.number().int().min(0).max(10000), maxFixedPerSaleMinor: commercialMinor,
    base: z.literal("retained-eligible-merchandise") }).strict(),
  samples: z.object({ eligible: z.boolean(), merchandiseCapMinor: commercialMinor, shippingCapMinor: commercialMinor,
    unitsPerCreatorCap: z.number().int().nonnegative().safe(), separateApprovalRequired: z.literal(true) }).strict(),
  routes: z.array(commercialRouteSchema).min(1).max(50), claimsRefs: z.array(commercialRef).max(50), disclosureRefs: z.array(commercialRef).max(50),
  pricing: z.object({ version: commercialRef, sourceRef: commercialRef, bundles: z.array(z.object({ id: z.enum(["single", "duo", "trio"]),
    units: z.number().int().positive().safe(), merchandiseMinor: commercialMinor, shippingMinor: commercialMinor }).strict()).min(1).max(3) }).strict(),
  performanceReward: rewardPolicySnapshotSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "effective" && (!value.effectiveAt || !value.approvalRef)) ctx.addIssue({ code: "custom", message: "Effective acquisition policy requires an approval and effective time." });
  if(Date.parse(value.validUntil)<=Date.parse(value.observedAt))ctx.addIssue({code:"custom",message:"Policy source leases must have positive duration."});
  if (new Set(value.pricing.bundles.map(row => row.id)).size !== value.pricing.bundles.length) ctx.addIssue({ code: "custom", message: "Price bundle IDs must be unique." });
  if (value.performanceReward && (value.performanceReward.scope.workspaceId!==value.scope.workspaceId || value.performanceReward.scope.accountId!==value.scope.accountId || value.performanceReward.scope.environment!==value.scope.environment)) ctx.addIssue({ code: "custom", message: "Reward terms must belong to the same scope." });
  if(BigInt(value.samples.merchandiseCapMinor)+BigInt(value.samples.shippingCapMinor)>BigInt(Number.MAX_SAFE_INTEGER))ctx.addIssue({code:"custom",message:"Combined sample exposure must remain an exact safe integer."});
  if(value.pricing.bundles.some(row=>row.units!==({single:1,duo:2,trio:3})[row.id] || row.merchandiseMinor>100_000_000 || row.shippingMinor>100_000_000))ctx.addIssue({code:"custom",message:"Price bundles must match their defined pack quantities and supported exact arithmetic range."});
});
export type CommercialPolicySnapshot = z.infer<typeof commercialPolicySnapshotSchema>;

/** Only a qualified server source/cache implements these methods. No request body establishes authority. */
export interface CommercialPolicySource {
  readCurrent(scope: CommercialScope): unknown;
  readRewardPolicy(input: { scope: CommercialScope; programmeRef: string; rewardVersion: string }): unknown;
  assertCurrent(snapshot: CommercialPolicySnapshot, now: number): void;
  assertRewardCurrent(snapshot: RewardPolicySnapshot, now: number): void;
}
