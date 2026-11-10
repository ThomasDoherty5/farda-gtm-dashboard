import { z } from "zod";
import { reference } from "../actions/contract.ts";
import { sourceUrlSchema } from "../intake/contract.ts";
import { providerFactsSchema } from "../offers/contract.ts";
import { routeAssessmentSchema } from "../routeEvidence.ts";

/**
 * J10 website-affiliate onboarding and attribution validation. Normalized internal types, never promised provider API
 * fields. This module records preflight, onboarding state and sandbox attribution evidence, and proposes J04 intents.
 * It never sends an invitation, issues a code, activates a relationship or reads a provider.
 */
export const JOB_ID = "J10" as const;
export const INVITATION_ACTION_KIND = "affiliateInvitation";
export const ACTIVATION_ACTION_KIND = "affiliateActivation";

export const instant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "A finite timestamp is required.");
const currency = z.string().regex(/^[A-Z]{3}$/);
const reason = z.string().trim().min(1).max(300);
export const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

/** Ref = {provider, accountId, sourceId, url}. The URL is a plain https source link, never an endpoint with credentials. */
export const refSchema = z.object({ provider: reference, accountId: reference, sourceId: reference, url: sourceUrlSchema.nullable() }).strict();
export type Ref = z.infer<typeof refSchema>;
/** Money = {minorUnits, currency}. Unknown money is null with a reason elsewhere, never zero. */
export const moneySchema = z.object({ minorUnits: z.number().int().safe(), currency }).strict();
export type Money = z.infer<typeof moneySchema>;

/** Evidence with a typed value. A null value must carry its unknown reason, and a known value must not. */
export function evidenceOf<T extends z.ZodTypeAny>(value: T) {
  return z.object({ ref: refSchema, observedAt: instant, sourceUpdatedAt: instant.nullable(), method: reference,
    value: value.nullable(), unknownReason: reason.nullable() }).strict()
    .refine(e => (e.value === null) === (e.unknownReason !== null), "Unknown evidence keeps an explicit reason; known evidence has none.")
    .refine(e => !e.sourceUpdatedAt || Date.parse(e.sourceUpdatedAt) <= Date.parse(e.observedAt), "A source update cannot follow its observation.");
}

export const ONBOARDING_ACTIONS = ["invite", "observeAcceptance", "issueLinkCode", "observeLinkCode", "sandboxCheckout", "activate"] as const;
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];
export const BLOCKER_OWNERS = ["merchant", "creator", "operator", "policy-owner", "provider"] as const;
export const blockerSchema = z.object({ code: reasonCode, owner: z.enum(BLOCKER_OWNERS), sourceRef: refSchema.nullable() }).strict();
export type Blocker = z.infer<typeof blockerSchema>;

export const storefrontRouteSchema = z.object({ checkoutOwner: reference, storefrontType: z.enum(["shopify-online-store", "shopify-headless", "other"]),
  url: sourceUrlSchema }).strict();
export type StorefrontRoute = z.infer<typeof storefrontRouteSchema>;

/** Approved terms as the ticket names them. The server re-reads the saved offer and refuses any disagreement. */
export const approvedTermsSchema = z.object({ policyVersion: reference, offerVersion: reference, rateType: z.enum(["percent", "fixed_per_sale"]),
  rateValue: z.string().trim().min(1).max(20), eligibleBase: reference, currency, approvalRef: refSchema }).strict();
export type ApprovedTerms = z.infer<typeof approvedTermsSchema>;

/**
 * The acquisition shape as requested. Amounts are accepted as untrusted numbers so a fee, paid-hybrid or gifted-only
 * request is refused with the shared commission-only reason codes instead of failing parsing.
 */
export const acquisitionRequestSchema = z.object({
  relationship: z.string().trim().min(1).max(40),
  upfrontFeeMinor: z.number().int().nonnegative().safe(), guaranteedFeeMinor: z.number().int().nonnegative().safe(),
  paidComponentMinor: z.number().int().nonnegative().safe(),
  /** Product and shipping, separately approved and costed. It is never a content fee. */
  productAllocation: z.object({ merchandiseMinor: z.number().int().nonnegative().safe(), shippingMinor: z.number().int().nonnegative().safe(),
    approvalRef: refSchema.nullable() }).strict().nullable(),
}).strict();
export type AcquisitionRequest = z.infer<typeof acquisitionRequestSchema>;

export const onboardingInputSchema = z.object({
  merchantRef: refSchema,
  /** The canonical creator: `sourceId` is the J01 canonical creator ID. */
  creatorRef: refSchema,
  objective: z.literal("website_affiliate"),
  providerProgram: z.object({ provider: z.enum(["shopify-collabs", "external-affiliate"]), programRef: refSchema.nullable(), version: reference }).strict(),
  offerId: reference,
  approvedTerms: approvedTermsSchema,
  acquisition: acquisitionRequestSchema,
  storefrontRoute: storefrontRouteSchema,
}).strict();
export type OnboardingInput = z.infer<typeof onboardingInputSchema>;

const verdict = z.object({ state: z.enum(["eligible", "ineligible", "unknown"]), sourceRef: reference.nullable(), unknownReason: reason.nullable() }).strict()
  .refine(v => (v.state === "unknown") === (v.unknownReason !== null), "Unknown eligibility keeps its reason.");
export const quotaSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("known"), unit: z.enum(["invitation", "request", "creator"]), limit: z.number().int().nonnegative().safe(),
    remaining: z.number().int().nonnegative().safe(), resetAt: instant, sourceRef: reference }).strict(),
  z.object({ state: z.literal("unknown"), unknownReason: reason }).strict(),
]);
export const definitionsSchema = z.object({ version: reference, gross: reason, eligible: reason, refund: reason, hold: reason,
  holdDays: z.number().int().nonnegative().nullable(), sourceRef: reference }).strict();
export type ProviderDefinitions = z.infer<typeof definitionsSchema>;
export const attributionPrecedenceSchema = z.enum(["link-over-code", "code-over-link", "last-touch", "unknown"]);

/**
 * The provider account record a preflight reads (J10-01). `origin: synthetic` is a test fixture: it can only be read
 * by this sandbox-scoped module and is labelled on every preflight. The real merchant or Collabs account is not bound.
 */
export const accountRecordSchema = z.object({
  origin: z.enum(["synthetic", "source"]),
  provider: z.enum(["shopify-collabs", "external-affiliate"]),
  providerAccountRef: reference, merchantRef: refSchema, creatorRef: refSchema,
  sourceRef: reference, observedAt: instant, validUntil: instant,
  plan: z.object({ name: reference.nullable(), sourceRef: reference.nullable(), unknownReason: reason.nullable() }).strict()
    .refine(p => (p.name === null) === (p.unknownReason !== null), "An unknown plan keeps its reason."),
  merchantEligibility: verdict, creatorEligibility: verdict,
  permissions: z.array(z.object({ action: z.enum(ONBOARDING_ACTIONS), state: z.enum(["granted", "denied", "unknown"]), sourceRef: reference.nullable() }).strict())
    .max(ONBOARDING_ACTIONS.length).refine(rows => new Set(rows.map(r => r.action)).size === rows.length, "List each action once."),
  quota: quotaSchema,
  commission: z.object({ supportsPercent: z.boolean().nullable(), supportsFixedPerSale: z.boolean().nullable(),
    eligibleBases: z.array(reference).max(10), currencies: z.array(currency).max(10), sourceRef: reference }).strict(),
  definitions: definitionsSchema.nullable(),
  attributionPrecedence: attributionPrecedenceSchema,
  payoutOwnerRef: reference, trackingOwnerRef: reference,
  recruitment: providerFactsSchema.shape.recruitment,
}).strict().refine(a => Date.parse(a.validUntil) > Date.parse(a.observedAt), "An account record needs a positive validity interval.");
export type AccountRecord = z.infer<typeof accountRecordSchema>;

/** The connection ledger's readiness answer for one onboarding action. Only `allowed` with `Ready` passes. */
export const capabilityReadinessSchema = z.object({ allowed: z.boolean(), state: z.enum(["Ready", "Unverified", "Unsupported", "Denied"]),
  reasonCodes: z.array(z.string()).max(30), capabilityId: z.string().nullable(), revision: z.number().int().nullable(),
  checkedAt: z.string().nullable(), expiresAt: z.string().nullable(), receiptRef: z.string().nullable(),
  ownerRef: z.string().nullable().optional(), recovery: z.string().optional() }).strict();

export const permissionRowSchema = z.object({ action: z.enum(ONBOARDING_ACTIONS), provider: z.enum(["granted", "denied", "unknown"]),
  capability: z.enum(["Ready", "Unverified", "Unsupported", "Denied"]), capabilityReceiptRef: z.string().nullable(), ready: z.boolean() }).strict();
export type PermissionRow = z.infer<typeof permissionRowSchema>;
export type PreflightRecord = {
  state: "ready" | "blocked"; origin: AccountRecord["origin"] | null; checkedAt: string; validUntil: string | null;
  providerAccountRef: string | null; plan: AccountRecord["plan"] | null;
  merchantEligibility: AccountRecord["merchantEligibility"] | null; creatorEligibility: AccountRecord["creatorEligibility"] | null;
  permissions: PermissionRow[]; quota: AccountRecord["quota"] | null; definitions: ProviderDefinitions | null;
  attributionPrecedence: z.infer<typeof attributionPrecedenceSchema>;
  commission: { rateType: ApprovedTerms["rateType"]; basisPoints: number | null; fixedMinor: number | null } | null;
  policyVersion: string | null; offerVersion: string | null; manifestHash: string | null; blockers: Blocker[];
};

/** The existing website-commerce test shape from route evidence, reused so matrix rows feed the same source gates. */
const websiteCommerceOption = routeAssessmentSchema.shape.commerce.unwrap().options[0];
export const websiteCommerceSchema = websiteCommerceOption;
export const attributionTestSchema = websiteCommerceOption.shape.test.unwrap();
export type AttributionTest = z.infer<typeof attributionTestSchema>;
export type WebsiteCommerce = z.infer<typeof websiteCommerceSchema>;

export const ONBOARDING_STATES = ["preflightBlocked", "readyToInvite", "invitationPending", "invitationUnknown", "invited", "invitationExpired",
  "declined", "feeRequested", "termsChanged", "accepted", "closed"] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];
export const PAYOUT_SETUP_STATES = ["notStarted", "waitingForCreator", "complete", "unknown"] as const;
export type PayoutSetupState = (typeof PAYOUT_SETUP_STATES)[number];
export type PhaseReadiness = { invitation: string; acceptance: string; linkCode: string; checkoutTest: string; payoutSetup: string; activation: string };

export type OnboardingRecord = {
  onboardingId: string; revision: number; creatorId: string; identityRevision: number;
  merchantRef: Ref; creatorRef: Ref; providerProgram: OnboardingInput["providerProgram"]; storefrontRoute: StorefrontRoute;
  offerId: string; offerVersion: string; approvedTerms: ApprovedTerms; acquisition: AcquisitionRequest;
  state: OnboardingState; stateReasons: string[]; preflight: PreflightRecord;
  invitation: { receipt: Ref | null; sentAt: string | null; expiresAt: string | null; expiredAt: string | null };
  acceptance: { state: "unknown" | "accepted" | "declined" | "feeRequested"; offerVersion: string | null; evidenceRef: Ref | null; observedAt: string | null };
  linkCode: { state: "notIssued" | "mapped"; relationshipRef: Ref | null; linkCodeRefs: LinkCodeRef[] };
  checkoutTest: { state: "notRun" | "passed" | "failed" | "exception" | "incomplete"; matrixRef: string | null; offerVersion: string | null };
  payoutSetup: { state: PayoutSetupState; owner: (typeof BLOCKER_OWNERS)[number] | null; sourceRef: Ref | null; observedAt: string | null; unknownReason: string | null };
  activation: { state: "notReady" | "proposed" | "active"; receipt: Ref | null; offerVersion: string | null };
  createdAt: string; updatedAt: string;
};
export const linkCodeRefSchema = z.object({ kind: z.enum(["link", "code"]), ref: refSchema }).strict();
export type LinkCodeRef = z.infer<typeof linkCodeRefSchema>;

/** A source observation for an onboarding. The source may be untrusted; it cannot change the account, terms or approval. */
const acceptanceValue = z.object({ offerId: reference, offerVersion: reference }).strict();
export const sourceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invitationExpired"), evidence: evidenceOf(z.object({ expiredAt: instant }).strict()) }).strict(),
  z.object({ type: z.literal("creatorDeclined"), evidence: evidenceOf(z.object({ offerVersion: reference }).strict()) }).strict(),
  z.object({ type: z.literal("creatorReply"), evidence: evidenceOf(z.object({ text: z.string().min(1).max(2000) }).strict()) }).strict(),
  z.object({ type: z.literal("acceptance"), evidence: evidenceOf(acceptanceValue) }).strict(),
]);
export type SourceEvent = z.infer<typeof sourceEventSchema>;

export const relationshipObservationSchema = z.object({
  evidence: evidenceOf(z.object({ relationshipRef: refSchema, linkCodeRefs: z.array(linkCodeRefSchema).min(1).max(10), offerVersion: reference }).strict()),
}).strict();
export type RelationshipObservation = z.infer<typeof relationshipObservationSchema>;

export const payoutSetupObservationSchema = z.object({
  evidence: evidenceOf(z.object({ state: z.enum(["notStarted", "waitingForCreator", "complete"]), owner: z.enum(BLOCKER_OWNERS) }).strict()),
}).strict().refine(o => o.evidence.value?.state !== "waitingForCreator" || (o.evidence.value.owner === "creator" && o.evidence.ref.url !== null),
  "Waiting for creator setup names the creator as owner and links the source.");
export type PayoutSetupObservation = z.infer<typeof payoutSetupObservationSchema>;

export const INTENT_STATES = ["proposed", "previewing", "awaitingApproval", "approvalHeld", "dispatched", "sent", "notSent",
  "reconciliationRequired", "superseded"] as const;
export type IntentState = (typeof INTENT_STATES)[number];
export type IntentKind = "invitation" | "activation";
export type StoredIntent = {
  intentRef: string; intentVersion: string; kind: IntentKind; actionKind: string; onboardingId: string; creatorId: string;
  offerId: string; offerVersion: string; manifestHash: string; termsHash: string; state: IntentState; holdReasons: string[];
  approvalRef: string | null; manifestRef: string | null; runRef: string | null; runVersion: string | null; receiptRefs: string[];
  providerReceipt: Ref | null; supersededBy: "termsChanged" | "closed" | null; supersededFrom: IntentState | null;
  sends: false; createdAt: string; updatedAt: string;
};

/**
 * What the actions service or executor reported for one intent. Uncertain, permission denied, login/MFA and UI drift
 * all preserve the approval and require source reconciliation before any replay.
 */
const outcomeBase = { intentRef: reference, approvalRef: reference.nullable(), manifestRef: reference.nullable() };
export const sendOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approvalRecorded"), ...outcomeBase, approvalRef: reference, manifestRef: reference }).strict(),
  z.object({ kind: z.literal("approvalHeld"), ...outcomeBase, reasonCodes: z.array(reasonCode).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("dispatchPending"), ...outcomeBase, approvalRef: reference, manifestRef: reference, runRef: reference, runVersion: reference }).strict(),
  z.object({ kind: z.literal("sent"), ...outcomeBase, approvalRef: reference, manifestRef: reference, runRef: reference, runVersion: reference,
    receiptRefs: z.array(reference).min(1).max(20), providerReceipt: refSchema, expiresAt: instant.nullable() }).strict(),
  z.object({ kind: z.literal("notSent"), ...outcomeBase, runRef: reference.nullable(), receiptRefs: z.array(reference).max(20) }).strict(),
  z.object({ kind: z.enum(["uncertain", "permissionDenied", "loginRequired", "uiDrift"]), ...outcomeBase, runRef: reference.nullable(), runVersion: reference.nullable() }).strict(),
]);
export type SendOutcome = z.infer<typeof sendOutcomeSchema>;

/** Source reconciliation for an intent whose outcome is unknown. Only the source can say it was found or is absent. */
export const reconciliationSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("found"), intentRef: reference, providerReceipt: refSchema, receiptRefs: z.array(reference).min(1).max(20), expiresAt: instant.nullable() }).strict(),
  z.object({ result: z.literal("absent"), intentRef: reference, sourceRef: refSchema, terminal: z.literal(true) }).strict(),
]);
export type Reconciliation = z.infer<typeof reconciliationSchema>;
