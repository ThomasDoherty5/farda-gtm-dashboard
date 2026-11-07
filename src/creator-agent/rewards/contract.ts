import { z } from "zod";

/**
 * Approved creator reward redemption (THO-348). J11 owns qualification, maturity and the entitlement; this module only redeems a
 * mature entitlement once, after an exact J04 decision, and reconciles the receipts. Nothing here buys anything without an injected,
 * trusted executor, and no test performs a real purchase.
 */
export const ref = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "Use an opaque reference.")
  .refine((value) => !/^https?:/i.test(value), "Use an opaque reference, not an endpoint.");
const time = z.string().datetime({ offset: true }).refine(s => Number.isFinite(Date.parse(s)), "Invalid receipt timestamp.");
const minor = z.number().int().nonnegative().max(100_000_000);
export const scopeSchema = z.object({ workspaceId: ref, accountId: ref }).strict();
export type RewardScope = z.infer<typeof scopeSchema>;
export const FULFILLMENT_DAYS = 30;

/** A J11 entitlement as its owner reports it. The amount is the all-in Farda obligation cap; it is never recalculated here. */
export const entitlementSchema = z.object({
  scope: scopeSchema, entitlementRef: ref, sourceRef: ref, creatorId: ref, programRef: ref, milestone: z.enum(["tech", "phone", "vacation"]),
  amountMinor: minor.positive(), currency: z.literal("USD"), rewardVersion: ref, state: z.enum(["mature", "pending", "reversed"]),
  qualifiedAt: time, fulfilled: z.boolean(), programPaused: z.boolean(), reserveMinor: minor.nullable(),
}).strict();
export type Entitlement = z.infer<typeof entitlementSchema>;

/** The reward terms version. Until the owner adopts it, every option is proposed and nothing can be redeemed. */
export const rewardPolicySchema = z.object({
  scope:scopeSchema, version: ref, state: z.enum(["adopted", "proposed"]), adoptionRef: ref.nullable(),
  options: z.array(z.object({
    optionId: ref, milestone: z.enum(["tech", "phone", "vacation"]), kind: z.enum(["item", "allowance", "trip"]),
    label: z.string().trim().min(1).max(120), providerRef: ref, deliveryRoute: z.enum(["provider-direct", "farda-physical", "allowance-transfer", "booking"]),
  }).strict()).max(50),
}).strict().superRefine((p, ctx) => {
  if ((p.state === "adopted") !== (p.adoptionRef !== null)) ctx.addIssue({ code: "custom", message: "An adopted version needs its adoption reference." });
});
export type RewardPolicy = z.infer<typeof rewardPolicySchema>;
export type RewardOption = RewardPolicy["options"][number];

/** A provider quote. Tax, shipping, booking and administration are inside the cap; a creator-funded upgrade is not Farda's. */
export const quoteSchema = z.object({
  scope:scopeSchema, quoteRef: ref, optionId: ref, providerRef: ref, available: z.boolean(), currency: z.literal("USD"),
  itemMinor: minor, taxMinor: minor, shippingMinor: minor, bookingMinor: minor, adminMinor: minor, creatorFundedMinor: minor, validUntil: time,
}).strict();
export type Quote = z.infer<typeof quoteSchema>;
export const providerStateSchema = z.object({
  scope: scopeSchema, providerRef: ref, deliveryRoute: ref, action:z.literal("purchase-reward"), bindingRef: ref, fundingRef: ref.nullable(), validUntil: time,
  state: z.enum(["Ready", "Unverified", "Unsupported", "Denied"]), fundingVerified: z.boolean(), ownerRef: ref,
}).strict();

export const prepareSchema = z.object({
  entitlementRef: ref, optionId: ref, quoteRef: ref, recipientRef: ref,
  detailsCompleteAt: time.nullable(), expiresAt: time,
}).strict();
export type PrepareInput = z.infer<typeof prepareSchema>;

/** Returned by the trusted J04 resolver, never supplied by a caller. */
export const decisionSchema = z.object({
  scope: scopeSchema, sourceRef: ref, redemptionId: ref, revision: z.number().int().positive(), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "rejected"]), state: z.enum(["current", "revoked"]), physicalAllocationRef: ref.nullable(),
  source: z.literal("linear-j04"), actorRole: z.literal("founder"), decidedAt: time, validUntil: time,
}).strict();
export const allocationSchema = z.object({
  scope: scopeSchema, sourceRef: ref, redemptionId: ref, requestHash: z.string().regex(/^[a-f0-9]{64}$/), revision:z.number().int().positive(),
  purpose: z.literal("creator-reward"), optionId: ref, recipientRef: ref, state: z.literal("reserved"), validUntil: time,
}).strict();
export const purchaseReceiptSchema = z.object({
  purchaseKey: ref, providerRef: ref, providerBindingRef: ref, providerOrderRef: ref, transactionRef: ref, chargedMinor: minor, currency: z.literal("USD"), purchasedAt: time,
}).strict();
export const purchaseLookupSchema = z.discriminatedUnion("state", [
  z.object({state:z.literal("found"),receipt:purchaseReceiptSchema}).strict(),
  z.object({state:z.literal("notFound"),purchaseKey:ref,providerRef:ref,providerBindingRef:ref,sourceRef:ref,checkedAt:time}).strict(),
]);
export const outcomeSchema = z.object({
  scope: scopeSchema, sourceRef: ref, redemptionId: ref, providerRef: ref, providerBindingRef: ref, providerOrderRef: ref,
  kind: z.enum(["shipped", "delivered", "failed", "returned", "refunded"]), refundMinor: minor, occurredAt: time,
}).strict();
export const cashMovementSchema = z.object({
  scope: scopeSchema, sourceRef: ref, providerRef: ref, providerBindingRef: ref, providerOrderRef: ref, transactionRef: ref, paidMinor: minor, refundedMinor: minor, currency: z.literal("USD"), postedAt: time,
}).strict();

export const REDEMPTION_STATES = ["held", "awaiting-details", "awaiting-approval", "approved", "rejected", "purchasing", "uncertain", "purchased",
  "shipped", "delivered", "failed", "returned", "refunded", "reconciled"] as const;
export type RedemptionState = (typeof REDEMPTION_STATES)[number];

export const redemptionViewSchema = z.object({
  kind: z.literal("reward-redemption"), redemptionId: ref, revision: z.number().int().positive(), state: z.enum(REDEMPTION_STATES),
  availability: z.enum(["proposed", "unavailable", "executable"]), entitlementRef: ref, entitlementSourceRef:ref, programRef:ref, creatorId: ref, milestone: z.enum(["tech", "phone", "vacation"]),
  rewardVersion: ref, option: z.object({ optionId: ref, kind: z.enum(["item", "allowance", "trip"]), label: z.string(), deliveryRoute: z.string() }).strict().nullable(),
  promise: z.string().nullable(), requestHash: z.string(), heldReasons: z.array(z.string()), ownerRef: ref.nullable(),
  clock: z.object({ qualifiedAt: time, detailsCompleteAt: time.nullable(), initiateBy: time.nullable(), overdue: z.boolean() }).strict(),
  money: z.object({
    currency:z.literal("USD"), capMinor: minor, fardaQuotedMinor:z.number().int().safe().nonnegative().nullable(), creatorFundedMinor: minor.nullable(), reserveMinor: minor.nullable(),
    earnedLiabilityMinor: minor, outstandingLiabilityMinor: minor, chargedMinor: minor.nullable(), refundedMinor: minor, settledCostMinor: minor.nullable(),
  }).strict(),
  receipts: z.object({ providerRef: ref.nullable(), providerBindingRef: ref.nullable(), decisionRef: ref.nullable(), physicalAllocationRef:ref.nullable(), providerOrderRef: ref.nullable(), transactionRef: ref.nullable(), cashRef: ref.nullable(), cashRefs: z.array(ref),
    outcomeRefs: z.array(ref) }).strict(),
  history: z.array(z.object({ state: z.enum(REDEMPTION_STATES), at: time, ref: ref.nullable() }).strict()),
  sourceEffects: z.enum(["none", "purchase-attempted"]),
}).strict();
export type RedemptionView = z.infer<typeof redemptionViewSchema>;
