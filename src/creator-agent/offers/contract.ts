import { z } from "zod";

const id = z.string().min(1).max(180).refine(value=>value.trim()===value,"Reference whitespace is not normalized.");
export const routeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const text = z.string().trim().min(1).max(600);
const time = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "A finite timestamp is required.");
const nullableText = text.nullable();
const money = z.number().int().min(0).max(100_000_000);
const count = z.number().int().min(0).max(10_000);
const bps = z.number().int().min(0).max(10_000);

export const CANDIDATE_VERSION = "CEO-v1";
export const BUNDLES = [
  { id: "single", units: 1, merchandiseMinor: 3499, shippingMinor: 599 },
  { id: "duo", units: 2, merchandiseMinor: 5598, shippingMinor: 599 },
  { id: "trio", units: 3, merchandiseMinor: 8398, shippingMinor: 599 },
] as const;
export const TIERS = [
  { id: "tech", label: "AirPods or tech", thresholdMinor: 600000, additionalMinor: 30000, cumulativeMinor: 30000 },
  { id: "phone", label: "Phone", thresholdMinor: 3000000, additionalMinor: 120000, cumulativeMinor: 150000 },
  { id: "vacation", label: "Vacation", thresholdMinor: 13000000, additionalMinor: 500000, cumulativeMinor: 650000 },
] as const;
export const scopeSchema = z.object({ workspaceId: id, accountId: id }).strict();
export type OfferScope = z.infer<typeof scopeSchema>;
export const checkoutSchema = z.enum(["website", "tiktok-shop"]);
export const assessmentBasisSchema = z.object({
  runId: id, creatorId: id, route: checkoutSchema, modelId: id, configHash: id.nullable(),
  policyVersion: id, termsRevision: id, stale: z.boolean(), state:z.enum(["reviewNeeded","hold","prospectiveInviteEligible","activationReady"]).optional(),
}).strict();
export type AssessmentBasis = z.infer<typeof assessmentBasisSchema>;
const deliverable = z.object({
  id, quantity: count.positive(), network: id, format: text, concept: nullableText, dueAt: time.nullable(),
  deadlineAnchor: nullableText, timezone: nullableText, disclosure: nullableText, cta: nullableText,
  previewAgreed: z.boolean().nullable(), revisionLimit: count.nullable(), rights: nullableText,
}).strict();
const manifest = z.object({
  campaignRef: id, briefRef: id, briefVersion: id, productRef: id.nullable(), productRevision: id.nullable(),
  guidanceRefs: z.array(id).max(30), claimsRefs: z.array(id).max(30), contactRoute: nullableText,
  linkOrCode: nullableText, deliverables: z.array(deliverable).max(50),
  productUse: z.enum(["separate-products-one-per-vial","single-product","unspecified"]),
  claims: z.array(z.enum(["routine-organization","separate-routines","free-essentials"])).max(3),
}).strict().superRefine((x,c) => {
  if (new Set(x.deliverables.map(d=>d.id)).size !== x.deliverables.length) c.addIssue({code:"custom",message:"Deliverable IDs must be distinct"});
});
const commission = z.object({
  type: z.enum(["percentage","fixed-per-sale"]), standardRateBps: bps.positive().nullable(),
  fixedMinor: money.positive().nullable(), shopAdsRateBps: bps.nullable(),
  currency: z.literal("USD"), base: z.literal("retained-eligible-merchandise"), effectiveAt: time.nullable(),
}).strict().superRefine((x,c) => {
  if (x.type === "percentage" ? x.standardRateBps === null || x.fixedMinor !== null : x.fixedMinor === null || x.standardRateBps !== null)
    c.addIssue({code:"custom",message:"Supply exactly one standard rate or fixed amount"});
});
export const costKeys = ["landedUnit","fulfillmentPerOrder","providerFeePerOrder","returnDefectPerOrder","samplePostagePerCreator","recruitment","advertising","earnedRewards","commissionAlreadyPaid"] as const;
const cost = z.object({ minor: money.nullable(), sourceRef: id.nullable() }).strict();
const costs = z.object(Object.fromEntries(costKeys.map(k=>[k,cost])) as Record<typeof costKeys[number],typeof cost>).strict();
const scenario = z.object({
  bundle: z.enum(["single","duo","trio"]), orders: count, shopAdsOrders: count, refundPerOrderMinor: money,
  sellerDiscountMinor: money, platformCouponMinor: money, fundedCouponMinor: money.nullable(), platformFundingRef:id.nullable().optional(),
}).strict().superRefine((x,c) => {
  if(x.shopAdsOrders>x.orders ||
    (x.fundedCouponMinor!==null && x.fundedCouponMinor>x.platformCouponMinor))
    c.addIssue({code:"custom",message:"Order allocation exceeds available counts or merchandise"});
});
export const offerTermsSchema = z.object({
  creatorId: routeId, recruitmentSource: id, publishingNetwork: id, checkoutRoute: checkoutSchema,
  provider: z.enum(["shopify-collabs","tiktok-shop","external-affiliate"]), programRef: id.nullable(),
  policyVersion: id, pricingVersion: id, rewardVersion: id.nullable(), rewardProgrammeRef: id.nullable().optional(),
  relationship: z.literal("commission-only"), upfrontFeeMinor: z.literal(0), guaranteedFeeMinor: z.literal(0),
  commission, sample: z.object({ requested: z.boolean(), seededCreators: count, unitsPerCreator: count, merchandiseCapMinor: money.nullable(), shippingCapMinor: money.nullable() }).strict(),
  offerCodeAddsDiscount: z.literal(false), stacking: z.literal("one-seller-discount"), subscriptionRequired: z.literal(false),
  expiresAt: time.nullable(), manifest, costs, base: scenario, downside: scenario,
  historicalObligationRefs: z.array(id).max(100), counterofferRef: id.nullable(),
}).strict().superRefine((x,c) => {
  if((x.checkoutRoute==="tiktok-shop")!==(x.provider==="tiktok-shop") || (x.provider!=="tiktok-shop" && (x.commission.shopAdsRateBps!==null || x.base.shopAdsOrders || x.downside.shopAdsOrders)))
    c.addIssue({code:"custom",message:"Checkout and commission must belong to the same provider route"});
  if(!x.sample.requested && (x.sample.seededCreators || x.sample.unitsPerCreator)) c.addIssue({code:"custom",message:"Sample units require a separately costed sample proposal"});
});
export type OfferTerms = z.infer<typeof offerTermsSchema>;
export function newOfferTerms(creatorId: string, route: OfferTerms["checkoutRoute"], briefId: string): OfferTerms {
  const costs = Object.fromEntries(costKeys.map(k=>[k,{minor:null,sourceRef:null}])) as OfferTerms["costs"];
  const scenario: OfferTerms["base"]={bundle:"single", orders:0, shopAdsOrders:0, refundPerOrderMinor:0, sellerDiscountMinor:0, platformCouponMinor:0, fundedCouponMinor:0};
  return {creatorId, recruitmentSource:"unknown", publishingNetwork:"unknown", checkoutRoute:route, provider:route==="website"?"shopify-collabs":"tiktok-shop",
    programRef:null, policyVersion:"commission-only-v1", pricingVersion:CANDIDATE_VERSION, rewardVersion:CANDIDATE_VERSION,
    relationship:"commission-only", upfrontFeeMinor:0, guaranteedFeeMinor:0, commission:{type:"percentage",standardRateBps:2000,fixedMinor:null,shopAdsRateBps:null,currency:"USD",base:"retained-eligible-merchandise",effectiveAt:null},
    sample:{requested:false,seededCreators:0,unitsPerCreator:0,merchandiseCapMinor:null,shippingCapMinor:null},offerCodeAddsDiscount:false,stacking:"one-seller-discount",subscriptionRequired:false,
    expiresAt:null,manifest:{campaignRef:"unassigned",briefRef:briefId,briefVersion:"draft-1",productRef:null,productRevision:null,guidanceRefs:[],claimsRefs:[],contactRoute:null,linkOrCode:null,deliverables:[],productUse:"unspecified",claims:[]},
    costs,base:{...scenario},downside:{...scenario},historicalObligationRefs:[],counterofferRef:null};
}
const moneyTotal=z.number().int().nonnegative().safe();
export const scenarioResultSchema = z.object({
  label: z.enum(["base","downside"]), orders:count, zeroSaleSeededCreatorsMinimum:count, seededCreators:count,
  merchandiseMinor:moneyTotal, shippingRevenueMinor:moneyTotal, commissionMinor:moneyTotal.nullable(), fixedCostsMinor:moneyTotal.nullable(),
  sampleMinor:moneyTotal.nullable(), contributionMinor:z.number().int().safe().nullable(), perOrderMarginMinor:z.number().int().safe().nullable(),
  breakEvenOrders:z.number().int().nonnegative().nullable(), reserveMinor:moneyTotal, earnedRewardMinor:moneyTotal.nullable(), paidCommissionCashMinor:moneyTotal.nullable(),
  missing:z.array(text),
}).strict();
export const providerFactsSchema = z.object({
  sourceRef:id, observedAt:time, validUntil:time, provider:z.enum(["shopify-collabs","tiktok-shop","external-affiliate"]), programRef:id,
  providerAccountRef:id.optional(),
  supportsPercentage:z.boolean(), supportsFixedPerSale:z.boolean(), actualCommission:commission, payoutOwner:id,
  attributionWindowDays:count.nullable(), precedence:nullableText, conflictRule:nullableText, holdDays:count.nullable(),
  payoutSchedule:nullableText, payoutThresholdMinor:money.nullable(), onboarding:nullableText, feeTreatment:nullableText,
  fundingRule:nullableText, refundRule:nullableText, trackingOwner:id,
  recruitment:z.object({source:z.enum(["social-cat","tiktok"]),campaignRef:id,campaignVersion:id,collaboration:z.enum(["affiliate","paid","gifted","unknown"]),
    sourceRef:id,observedAt:time,validUntil:time}).strict().optional(),
}).strict();
export const offerRecordSchema = z.object({
  kind:z.literal("agent-offer"), offerId:routeId, version:id, revision:count, recordedAt:time, manifestHash:id,
  terms:offerTermsSchema, assessment:assessmentBasisSchema.nullable(), assessmentCurrent:z.boolean(), draftAssessment:assessmentBasisSchema.nullable().optional(),
  scenarios:z.array(scenarioResultSchema).length(2), provider:providerFactsSchema.nullable(), blockers:z.array(text),
  state:z.enum(["proposed","approved","accepted"]), ownerApprovalRef:id.nullable(), acceptedRef:id.nullable(),
  history:z.array(z.object({version:id,hash:id,at:time}).strict()).max(100), historyTotal:count,
  commercial:z.object({state:z.enum(["unknown","proposed","effective","held"]),policyVersion:id.nullable(),policyHash:id.nullable(),
    pricingVersion:id.nullable(),pricingBasis:z.enum(["candidate","source"]),
    bundles:z.array(z.object({id:z.enum(["single","duo","trio"]),units:count.positive(),merchandiseMinor:money,shippingMinor:money}).strict()).min(1).max(3).nullable().optional(),
    rewardVersion:id.nullable(),reasonCodes:z.array(id),replyRevision:count}).strict().optional(),
}).strict();
export type OfferRecord = z.infer<typeof offerRecordSchema>;
export type ProviderFacts = z.infer<typeof providerFactsSchema>;

export const rewardsRecordSchema = z.object({
  kind:z.literal("agent-rewards"), offerId:routeId, creatorId:id, version:id, sourceRef:id.nullable(), observedAt:time.nullable(),
  status:z.enum(["unobserved","observed"]), maturedMinor:moneyTotal.nullable(), pendingMinor:moneyTotal.nullable(),
  excludedMinor:moneyTotal.nullable(), refundedMinor:moneyTotal.nullable(), duplicateMirrors:count, pendingOrders:count.nullable(),
  commissionMinor:moneyTotal.nullable(), earnedMinor:moneyTotal.nullable(), redeemedMinor:moneyTotal.nullable(),
  outstandingMinor:moneyTotal.nullable(), contributionMinor:z.number().int().nullable(), paused:z.boolean().nullable(),
  tiers:z.array(z.object({id:z.enum(["tech","phone","vacation"]),earned:z.boolean().nullable(),redeemedMinor:moneyTotal.nullable(),selection:nullableText}).strict()).length(3),
  unknowns:z.array(text),
}).strict();
export type RewardRecord = z.infer<typeof rewardsRecordSchema>;
