import { z } from "zod";
import { capabilityStateSchema } from "../connections/schema.ts";

/**
 * Paid-media campaign drafts and guarded Meta/TikTok execution (THO-346). Native purchase-optimized delivery is reused; nothing here
 * bids in an auction. Every account fact, capability observation, gate, J04 decision and provider write comes from an injected,
 * trusted source. None is connected, and no test touches a real advertiser account or spends money.
 */
export const ref = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "Use an opaque reference.")
  .refine((value) => !/^https?:/i.test(value), "Use an opaque reference, not an endpoint.");
/** An instant that actually parses. zod alone accepts impossible offsets such as +99:99, which would never expire. */
const time = z.string().datetime({ offset: true }).refine((s) => Number.isFinite(Date.parse(s)), "Invalid timestamp.");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const minor = z.number().int().nonnegative().max(100_000_000);
export const scopeSchema = z.object({ workspaceId: ref, accountId: ref }).strict();
export type MediaScope = z.infer<typeof scopeSchema>;

export const PROVIDERS = ["meta", "tiktok"] as const;
export type MediaProvider = (typeof PROVIDERS)[number];
/** The per-operation capabilities inventoried for every account. */
export const OPERATIONS = ["read-reports", "upload-creative", "preview-creative", "create-draft", "publish", "edit-budget", "pause", "retrieve-outcome"] as const;
export type MediaOperation = (typeof OPERATIONS)[number];
/** Programmatic routes come first. A browser route is a separate capability, never a fallback for a denied one. */
export const EXEC_ROUTES = ["api", "mcp", "browser"] as const;
export type ExecRoute = (typeof EXEC_ROUTES)[number];
export const ENVIRONMENTS = ["sandbox", "production"] as const;
export const receiptOriginSchema = z.enum(["synthetic", "account"]);
export type ReceiptOrigin = z.infer<typeof receiptOriginSchema>;

/** One observation of one operation on one route for one account, as the trusted capability source reports it. */
export const capabilityObservationSchema = z.object({
  scope: scopeSchema, provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS), operation: z.enum(OPERATIONS),
  route: z.enum(EXEC_ROUTES), state: capabilityStateSchema,
  // An account test is the only evidence that can make an operation Ready. Tool discovery or documentation is not account authorization.
  evidence: z.enum(["account-test", "mcp-discovery", "documentation"]), sourceRef: ref, toolVersion: ref, receiptRef: ref.nullable(),
  receiptOrigin: receiptOriginSchema, checkedAt: time.nullable(), expiresAt: time.nullable(),
}).strict();

/** The advertiser, business or shop account. Unknown market, timezone or identity stays null and holds the campaign. */
export const accountSchema = z.object({
  scope: scopeSchema, provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS),
  kind: z.enum(["advertiser", "business", "shop"]), businessRef: ref.nullable(), market: z.string().regex(/^[A-Z]{2}$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), timezone: z.string().min(1).max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/).nullable(),
  identityRef: ref.nullable(), identityApproved: z.boolean(), sourceRef: ref, receiptOrigin: receiptOriginSchema, observedAt: time,
}).strict();
export type MediaAccount = z.infer<typeof accountSchema>;

/** The actual checkout a buyer reaches. The route is chosen from this, not from a preference. */
export const checkoutSchema = z.object({
  scope: scopeSchema, checkoutRef: ref, kind: z.enum(["website", "tiktok-shop"]), skuRef: ref, destinationRef: ref,
  purchaseEventsVerified: z.boolean(), shopAuthorizationVerified: z.boolean(), sourceRef: ref, validUntil: time,
}).strict();
export type Checkout = z.infer<typeof checkoutSchema>;

export const offerVersionSchema = z.object({
  scope: scopeSchema, offerRef: ref, version: ref, skuRef: ref, claimsVersion: ref, state: z.enum(["approved", "draft", "withdrawn"]), validUntil: time,
}).strict();
export const assetSchema = z.object({
  scope: scopeSchema, assetRef: ref, contentHash: hash, claimsVersion: ref, reviewed: z.boolean(),
  rights: z.object({ rightsRef: ref, rightsHash: hash, paidUsage: z.boolean(), nativePermission: z.boolean(), expiresAt: time }).strict(),
}).strict();

export const CAMPAIGN_ROUTES = ["meta-sales-purchase", "tiktok-gmv-max-product", "tiktok-smart-plus-web-sales"] as const;
export type CampaignRoute = (typeof CAMPAIGN_ROUTES)[number];
/** Native, purchase-optimized presets. Extras that would add budget or widen placement are always off and checked on read-back. */
export const ROUTE_PRESETS: Record<CampaignRoute, { provider: MediaProvider; checkout: Checkout["kind"]; objective: string; optimizationEvent: string;
  bidStrategies: readonly ("lowest-cost" | "cost-cap" | "roas-target")[] }> = {
  "meta-sales-purchase": { provider: "meta", checkout: "website", objective: "sales", optimizationEvent: "purchase", bidStrategies: ["lowest-cost", "cost-cap", "roas-target"] },
  "tiktok-gmv-max-product": { provider: "tiktok", checkout: "tiktok-shop", objective: "product-gmv-max", optimizationEvent: "gross-revenue", bidStrategies: ["roas-target"] },
  "tiktok-smart-plus-web-sales": { provider: "tiktok", checkout: "website", objective: "web-sales", optimizationEvent: "purchase", bidStrategies: ["lowest-cost", "cost-cap"] },
};

const bidSchema = z.object({
  strategy: z.enum(["lowest-cost", "cost-cap", "roas-target"]), costCapMinor: minor.positive().nullable(), targetRoasBps: z.number().int().positive().max(1_000_000).nullable(),
}).strict().superRefine((b, ctx) => {
  if ((b.strategy === "cost-cap") !== (b.costCapMinor !== null)) ctx.addIssue({ code: "custom", message: "A cost cap is set only for the cost-cap strategy." });
  if ((b.strategy === "roas-target") !== (b.targetRoasBps !== null)) ctx.addIssue({ code: "custom", message: "A ROI target is set only for the roas-target strategy." });
});
const capsSchema = z.object({ dailyBudgetMinor: minor.positive(), lifetimeBudgetMinor: minor.positive() }).strict()
  .refine((c) => c.lifetimeBudgetMinor >= c.dailyBudgetMinor, "The lifetime cap covers at least one day.");
const targetingSchema = z.object({
  markets: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20), ageMin: z.number().int().min(18).max(65), ageMax: z.number().int().min(18).max(65),
  placements: z.array(ref).min(1).max(20),
}).strict().refine((t) => t.ageMin <= t.ageMax, "Age range is inverted.");

export const prepareSchema = z.object({
  campaignRef: ref, provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS), campaignRoute: z.enum(CAMPAIGN_ROUTES),
  checkoutRef: ref, offerRef: ref, creativeRefs: z.array(ref).min(1).max(10), destinationRef: ref, attributionSetting: ref,
  schedule: z.object({ startAt: time, endAt: time }).strict().refine((s) => Date.parse(s.startAt) < Date.parse(s.endAt), "The schedule ends after it starts."),
  currency: z.literal("USD"), targeting: targetingSchema, bid: bidSchema, caps: capsSchema, expiresAt: time,
}).strict();
export type PrepareInput = z.infer<typeof prepareSchema>;

/** Always false in a manifest. A native preset that turns any of them on fails read-back. */
export const deliveryExtrasSchema = z.object({
  extraDeliveryBudget: z.literal(false), maxDelivery: z.literal(false), autoRecharge: z.literal(false), placementExpansion: z.literal(false),
}).strict();

/** The immutable campaign manifest. It is stored once per revision and hashed; the hash is what J04 approves. */
export const manifestSchema = z.object({
  scope: scopeSchema, campaignRef: ref, provider: z.enum(PROVIDERS), environment: z.enum(ENVIRONMENTS),
  account: z.object({ providerAccountRef: ref, kind: z.string(), market: z.string(), currency: z.literal("USD"), timezone: z.string(), identityRef: ref }).strict(),
  campaignRoute: z.enum(CAMPAIGN_ROUTES), objective: z.string(), optimizationEvent: z.string(),
  checkout: z.object({ checkoutRef: ref, kind: z.enum(["website", "tiktok-shop"]), skuRef: ref }).strict(),
  offer: z.object({ offerRef: ref, version: ref, skuRef: ref, claimsVersion: ref }).strict(),
  creatives: z.array(z.object({ assetRef: ref, contentHash: hash, rightsRef: ref, rightsHash: hash, rightsExpiresAt: time }).strict()).min(1),
  destinationRef: ref, attributionSetting: ref, schedule: z.object({ startAt: time, endAt: time }).strict(), currency: z.literal("USD"),
  targeting: targetingSchema, bid: bidSchema, caps: capsSchema, deliveryExtras: deliveryExtrasSchema,
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;

/** What the provider reports for a native campaign. Compared field by field with the manifest. */
export const nativeSettingsSchema = z.object({
  nativeCampaignId: ref, provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS), identityRef: ref.nullable(), nativeAdIds: z.array(ref).max(10), previewRef: ref.nullable(),
  status: z.enum(["DRAFT", "PAUSED", "ACTIVE", "IN_REVIEW", "REJECTED"]),
  objective: z.string(), optimizationEvent: z.string(), currency: z.string(), dailyBudgetMinor: minor.nullable(), lifetimeBudgetMinor: minor.nullable(),
  startAt: time.nullable(), endAt: time.nullable(), attributionSetting: ref.nullable(), destinationRef: ref.nullable(), creativeHashes: z.array(hash).max(10),
  markets: z.array(z.string()).max(20), ageMin: z.number().int().nullable(), ageMax: z.number().int().nullable(), placements: z.array(ref).max(40),
  bidStrategy: z.string().nullable(), costCapMinor: minor.nullable(), targetRoasBps: z.number().int().nullable(),
  extraDeliveryBudget: z.boolean(), maxDelivery: z.boolean(), autoRecharge: z.boolean(), placementExpansion: z.boolean(),
  receiptOrigin: receiptOriginSchema, observedAt: time,
}).strict();
export type NativeSettings = z.infer<typeof nativeSettingsSchema>;

export const handoffSchema = z.object({ key: z.string(), handoff: z.enum(["mfa", "captcha", "ui-drift"]) }).strict();
export const draftReceiptSchema = z.object({
  key: z.string(), nativeCampaignId: ref, nativeAdIds: z.array(ref).max(10), previewRef: ref, receiptRef: ref, receiptOrigin: receiptOriginSchema,
}).strict();
export const publishReceiptSchema = z.object({
  key: z.string(), nativeCampaignId: ref, receiptRef: ref, receiptOrigin: receiptOriginSchema, providerStatus: z.enum(["ACTIVE", "IN_REVIEW", "REJECTED"]),
  rejectionCode: ref.nullable(),
}).strict();
export const mutationReceiptSchema = z.object({
  key: z.string(), nativeCampaignId: ref, receiptRef: ref, receiptOrigin: receiptOriginSchema, outcome: z.enum(["applied", "rejected"]), rejectionCode: ref.nullable(),
}).strict();

/** The five media gates (THO-347). Each needs its own verified, unexpired receipt for this exact manifest. */
export const MEDIA_GATES = ["qualified-product-stock", "reviewed-content-paid-rights", "actual-offer-checkout", "attribution-dedup-refunds",
  "fulfillment-support-cash"] as const;
export type MediaGate = (typeof MEDIA_GATES)[number];
export const gateReceiptSchema = z.object({
  scope: scopeSchema, gate: z.enum(MEDIA_GATES), sourceRef: ref, campaignId: ref, manifestHash: hash, state: z.enum(["verified", "held", "failed"]),
  verifiedAt: time, expiresAt: time, receiptOrigin: receiptOriginSchema,
}).strict();

export const MUTATION_KINDS = ["edit-budget", "pause"] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];
/** Returned by the trusted J04 resolver, never supplied by a caller. Only a Linear decision can release; Slack or Notion is a signal. */
export const decisionSchema = z.object({
  scope: scopeSchema, sourceRef: ref, system: z.enum(["linear", "slack", "notion"]), campaignId: ref, revision: z.number().int().positive(),
  action: z.enum(["publish", ...MUTATION_KINDS]), manifestHash: hash, subjectHash: hash, decision: z.enum(["approved", "rejected"]),
  state: z.enum(["current", "revoked"]),
  financialScope: z.object({
    providerAccountRef: ref, campaignRoute: z.enum(CAMPAIGN_ROUTES), currency: z.literal("USD"), maxDailyBudgetMinor: minor, maxLifetimeBudgetMinor: minor,
    placements: z.array(ref).max(20),
  }).strict(),
  decidedAt: time, validUntil: time,
}).strict();
export type MediaDecision = z.infer<typeof decisionSchema>;

/**
 * A previously authorized safety policy (THO-347). It may only pause, never raise spend, and only for the accounts it names. Returned by a
 * trusted resolver, never supplied by a caller.
 */
export const safetyPolicySchema = z.object({
  scope: scopeSchema, policyRef: ref, state: z.enum(["current", "revoked"]), allows: z.array(z.literal("pause")).min(1).max(1),
  accounts: z.array(z.object({ provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS) }).strict()).min(1).max(50),
  validUntil: time,
}).strict();
/** A mutation is applied with its own J04 decision, or, for a pause only, under a current safety policy. */
export const mutationAuthorizationSchema = z.union([z.object({ decisionRef: ref }).strict(), z.object({ policyRef: ref }).strict()]);
export type MutationAuthorization = z.infer<typeof mutationAuthorizationSchema>;
export const mutationInputSchema = z.object({ kind: z.enum(MUTATION_KINDS), dailyBudgetMinor: minor.positive().nullable() }).strict()
  .refine((m) => (m.kind === "edit-budget") === (m.dailyBudgetMinor !== null), "Only a budget edit carries a budget.");
export const inventoryInputSchema = z.object({ provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS) }).strict();

export const CAMPAIGN_STATES = ["held", "draft", "approved", "rejected", "applying", "confirmed", "provider-rejected", "uncertain"] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];
export const MUTATION_STATES = ["held", "draft", "approved", "rejected", "applying", "confirmed", "provider-rejected", "uncertain", "not-applied"] as const;
export type MutationState = (typeof MUTATION_STATES)[number];
const evidenceLabel = z.enum(["none", "synthetic", "account-backed", "mixed"]);
const receiptEntry = z.object({ kind: z.string(), ref: ref, origin: receiptOriginSchema, at: time }).strict();

export const capabilityEntrySchema = z.object({
  operation: z.enum(OPERATIONS), route: z.enum(EXEC_ROUTES), observedState: capabilityStateSchema.nullable(), state: capabilityStateSchema,
  evidence: z.string().nullable(), sourceRef: ref.nullable(), toolVersion: ref.nullable(), receiptRef: ref.nullable(), receiptOrigin: receiptOriginSchema.nullable(),
  checkedAt: time.nullable(), expiresAt: time.nullable(), reasons: z.array(z.string()),
}).strict();
export type CapabilityEntry = z.infer<typeof capabilityEntrySchema>;
export const inventoryViewSchema = z.object({
  kind: z.literal("paid-media-inventory"), inventoryId: ref, provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS),
  account: accountSchema.omit({ scope: true }).nullable(), accountReasons: z.array(z.string()), capabilities: z.array(capabilityEntrySchema),
  recordedAt: time, evidenceLabel,
}).strict();
export type InventoryView = z.infer<typeof inventoryViewSchema>;

export const mutationViewSchema = z.object({
  kind: z.literal("paid-media-mutation"), mutationId: ref, campaignId: ref, action: z.enum(MUTATION_KINDS), dailyBudgetMinor: minor.nullable(),
  requestHash: hash, state: z.enum(MUTATION_STATES), heldReasons: z.array(z.string()), decisionRef: ref.nullable(), policyRef: ref.nullable(),
  authorizedBy: z.enum(["j04", "safety-policy"]).nullable(),
  route: z.enum(EXEC_ROUTES).nullable(), before: nativeSettingsSchema.nullable(), after: nativeSettingsSchema.nullable(), receiptRef: ref.nullable(),
  providerRejectionCode: ref.nullable(), reconciledBy: z.enum(["receipt", "native-readback"]).nullable(), evidenceLabel,
  history: z.array(z.object({ state: z.enum(MUTATION_STATES), at: time, ref: ref.nullable() }).strict()),
  sourceEffects: z.enum(["none", "mutation-attempted"]),
}).strict();
export type MutationView = z.infer<typeof mutationViewSchema>;

export const campaignViewSchema = z.object({
  kind: z.literal("paid-media-campaign"), campaignId: ref, campaignRef: ref, revision: z.number().int().positive(), state: z.enum(CAMPAIGN_STATES),
  provider: z.enum(PROVIDERS), environment: z.enum(ENVIRONMENTS), campaignRoute: z.enum(CAMPAIGN_ROUTES), manifest: manifestSchema.nullable(),
  manifestHash: hash.nullable(), releaseHash: hash.nullable(), releaseRequested: z.boolean(), heldReasons: z.array(z.string()),
  native: z.object({ nativeCampaignId: ref.nullable(), nativeAdIds: z.array(ref), previewRef: ref.nullable(), status: z.string().nullable(),
    readback: nativeSettingsSchema.nullable() }).strict(),
  approval: z.object({ decision: z.enum(["none", "approved", "rejected"]), decisionRef: ref.nullable(), validUntil: time.nullable() }).strict(),
  providerReview: z.object({ state: z.enum(["not-submitted", "in-review", "active", "rejected"]), rejectionCode: ref.nullable() }).strict(),
  gates: z.array(z.object({ gate: z.enum(MEDIA_GATES), state: z.enum(["not-checked", "verified", "missing", "mismatch", "expired", "held", "failed"]),
    sourceRef: ref.nullable(), receiptOrigin: receiptOriginSchema.nullable() }).strict()),
  execution: z.object({ route: z.enum(EXEC_ROUTES).nullable(), key: z.string().nullable(), leaseUntil: time.nullable(), pending: z.boolean(),
    reconciledBy: z.enum(["receipt", "native-readback"]).nullable() }).strict(),
  receipts: z.array(receiptEntry), evidenceLabel, mutations: z.array(z.object({ mutationId: ref, action: z.enum(MUTATION_KINDS), state: z.enum(MUTATION_STATES) }).strict()),
  history: z.array(z.object({ state: z.enum(CAMPAIGN_STATES), at: time, ref: ref.nullable() }).strict()),
  sourceEffects: z.enum(["none", "draft-created", "publish-attempted"]),
}).strict();
export type CampaignView = z.infer<typeof campaignViewSchema>;
