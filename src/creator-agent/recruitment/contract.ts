import { z } from "zod";
import { approvalInstantSchema as instant, approvalRefSchema as ref, approvalScopeSchema } from "../approvals/contract.ts";
import { nativeApprovalViewSchema, nativeRunViewSchema } from "../actions/views.ts";
import { reviewFieldSchema, reviewLinkSchema } from "../actions/reviewViews.ts";
import { commercialEligibilityViewSchema } from "../commercialPolicy/views.ts";
import { routeId } from "../offers/contract.ts";

export const recruitmentReason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
export const recruitmentCount = z.number().int().nonnegative().safe();
const offerVersion = z.string().regex(/^v[1-9]\d*$/);
export const invitationFiltersSchema = z.object({
  context: z.literal("recruitment"),
  draftId: routeId.optional(), creatorId: routeId.optional(), offerId: routeId.optional(), offerVersion: offerVersion.optional(),
  requestKey: ref.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.offerId === undefined) !== (value.offerVersion === undefined))
    ctx.addIssue({ code: "custom", message: "An exact offer selection requires its version." });
  if (value.offerId && !value.creatorId || value.requestKey && !value.draftId)
    ctx.addIssue({ code: "custom", message: "Select the exact creator or original draft before reading its evidence." });
});
export const recruitmentBatchFiltersSchema = z.object({
  context: z.literal("recruitment"),
  batchId: ref, source: z.enum(["all", "social-cat", "tiktok"]).default("all"),
  deal: z.enum(["all", "affiliate", "historical"]).default("all"), owner: ref.nullable().default(null),
  deadline: z.enum(["all", "overdue", "dated", "undated"]).default("all"),
}).strict();
export type InvitationFilters = z.infer<typeof invitationFiltersSchema>;
export type RecruitmentBatchFilters = z.infer<typeof recruitmentBatchFiltersSchema>;

export const invitationTermsSchema = z.object({
  creatorId: routeId, offerId: routeId, offerVersion, productRef: ref, programRef: ref,
  sourceVersion: ref, templateRef: ref, templateVersion: ref, claimsVersion: ref,
  message: z.string().trim().min(1).max(5_000), startsAt: instant, expiresAt: instant,
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
  }), sampleRequested: z.boolean(),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.startsAt), "Expiry must follow the exact start.");
export type InvitationTerms = z.infer<typeof invitationTermsSchema>;
export const invitationDraftSchema = z.object({
  draftId: routeId, version: ref, recordedAt: instant, actorRef: ref, terms: invitationTermsSchema,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceEffect: z.literal("none"),
}).strict();
export type InvitationDraft = z.infer<typeof invitationDraftSchema>;
export const invitationSaveSchema = z.object({ kind: z.literal("recruitmentInvitation"), draftId: routeId,
  expectedVersion: z.string().regex(/^invitation-v[1-9]\d*$/).nullable(), terms: invitationTermsSchema }).strict();
export type InvitationSave = z.infer<typeof invitationSaveSchema>;
export const invitationSaveReceiptSchema = z.object({ resourceRef: routeId, version: ref, resource: invitationDraftSchema,
  scope: approvalScopeSchema, expectedVersion: z.string().regex(/^invitation-v[1-9]\d*$/).nullable(), actorRef: ref,
  updatedAt: instant, requestKey: ref, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceEffect: z.literal("none") }).strict().superRefine((value,ctx)=>{
    if(value.resourceRef!==value.resource.draftId||value.version!==value.resource.version||value.actorRef!==value.resource.actorRef||value.updatedAt!==value.resource.recordedAt)
      ctx.addIssue({code:"custom",message:"The exact receipt must identify its immutable draft revision and actor."});
  });
export type InvitationSaveReceipt = z.infer<typeof invitationSaveReceiptSchema>;
export const invitationRecoverySchema = z.object({ requestKey: ref, state: z.enum(["recorded", "notFound"]),
  receipt: invitationSaveReceiptSchema.nullable(), confersRetry: z.literal(false) }).strict().superRefine((value,ctx)=>{
    if((value.state==="recorded")!==(value.receipt!==null)||value.receipt&&value.receipt.requestKey!==value.requestKey)
      ctx.addIssue({code:"custom",message:"Recovery must retain the original exact request receipt."});
  });

const selection = z.object({ ref, label: reviewFieldSchema, eligible: z.boolean().nullable(), reasonCodes: z.array(recruitmentReason).max(30) }).strict();
export const recruitmentCapacitySchema = z.object({
  kind: z.enum(["invitations", "collaborationSlots", "sampleUnits", "authorizedCost"]),
  unit: z.string().min(1).max(60), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  remaining: recruitmentCount.nullable(), limit: recruitmentCount.nullable(),
  observedAt: instant.nullable(), validUntil: instant.nullable(), resetAt: instant.nullable(),
  reasonCodes: z.array(recruitmentReason).max(30),
}).strict().superRefine((value, ctx) => {
  if (value.remaining !== null && value.limit !== null && value.remaining > value.limit)
    ctx.addIssue({ code: "custom", message: "Remaining capacity cannot exceed the source limit." });
  if ((value.remaining !== null || value.limit !== null) && (!value.observedAt || !value.validUntil))
    ctx.addIssue({ code: "custom", message: "Known capacity needs current source evidence." });
  if (value.kind === "authorizedCost" ? value.currency === null : value.currency !== null)
    ctx.addIssue({ code: "custom", message: "Cost and count dimensions remain separate." });
});
export const sampleRequestViewSchema = z.object({
  requestRef: ref, version: ref, creatorRef: ref,
  sourceRef: ref, observedAt: instant, validUntil: instant,
  requestType: z.enum(["open", "target", "other", "unknown"]),
  nativeState: z.enum(["pending", "approved", "declined", "expired", "unknown"]),
  deadline: instant.nullable(),
  route: z.enum(["verifiedApi", "permittedBrowser", "ownerHandoff", "held"]),
  capabilityVersion: ref.nullable(), reasonCodes: z.array(recruitmentReason).max(30),
  approvalRef: ref.nullable(), runRef: ref.nullable(), receiptRef: ref.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.route === "verifiedApi" && (value.requestType !== "open" || value.nativeState !== "pending" || !value.capabilityVersion))
    ctx.addIssue({ code: "custom", message: "The verified API route requires an exact PENDING Open request." });
  if (value.route === "permittedBrowser" && !value.capabilityVersion)
    ctx.addIssue({ code: "custom", message: "Browser permission must be independently verified." });
  if (value.reasonCodes.includes("TIKTOK_PERMISSION_DENIED_16022020") && value.route !== "ownerHandoff")
    ctx.addIssue({ code: "custom", message: "A permission denial requires owner handoff, never browser fallback." });
});
const sourceHeader = {
  provenance: z.discriminatedUnion("evidenceStage", [
    z.object({ evidenceStage: z.literal("synthetic"), synthetic: z.literal(true) }).strict(),
    z.object({ evidenceStage: z.literal("source"), synthetic: z.literal(false) }).strict(),
  ]),
  sourceVersion: ref, observedAt: instant, validUntil: instant, actorRef: ref,
  sourceState: z.enum(["current", "partial"]), reasonCodes: z.array(recruitmentReason).max(30),
};
export const nativeInvitationViewSchema = z.object({
  kind: z.literal("native-invitation"), ...sourceHeader, filters: invitationFiltersSchema,
  provider: z.enum(["social-cat", "tiktok"]), account: reviewFieldSchema,
  creators: z.array(selection.extend({ creatorId: routeId })).max(100),
  products: z.array(selection.extend({ programRef: ref, market: reviewFieldSchema, category: reviewFieldSchema })).max(100),
  templates: z.array(z.object({ ref, version: ref, claimsVersion: ref, label: reviewFieldSchema, text: reviewFieldSchema })).max(30),
  limits: z.object({ maxRateBps: recruitmentCount.max(10_000).nullable(), maxValiditySeconds: recruitmentCount.nullable(),
    startsNotBefore: instant.nullable(), expiresNotAfter: instant.nullable(), timezone: z.string().min(1).max(100).nullable() }).strict(),
  offer: z.object({ offerId: routeId, version: offerVersion, creatorId: routeId, publishingNetwork: z.string(),
    expiresAt: instant.nullable(),
    checkoutRoute: z.enum(["website", "tiktok-shop"]), standardRateBps: recruitmentCount.nullable(), fixedPerSaleMinor: recruitmentCount.nullable(),
    shopAdsRateBps: recruitmentCount.nullable(), sampleUnits: recruitmentCount, currency: z.literal("USD"),
    relationship: z.literal("commission-only"), upfrontFeeMinor: z.literal(0), guaranteedFeeMinor: z.literal(0),
    accepted: z.boolean().nullable(), commercialEligibility: commercialEligibilityViewSchema }).strict().nullable(),
  willingness: z.enum(["unknown", "willing", "feeRequested", "declined"]),
  draft: invitationDraftSchema.nullable(), capacity: z.array(recruitmentCapacitySchema).max(4),
  requestRecovery: invitationRecoverySchema.nullable(),
  samples: z.array(sampleRequestViewSchema).max(100),
  sourceLink: reviewLinkSchema, canSaveDraft: z.boolean(), canPreview: z.boolean(),
  dispatchAuthorized: z.literal(false),
  previewSelectionRefs: z.array(ref).max(1),
  previewApprovalRef: ref.nullable(),
}).strict();
export type NativeInvitationView = z.infer<typeof nativeInvitationViewSchema>;

/** Checkout chooses the model; this is source evidence, never a browser model selector. */
export const recruitmentModelSchema = z.object({
  route: z.enum(["website", "tiktok-shop"]), name: z.enum(["WEBSITE-AFFILIATE-v3", "TIKTOK-SHOP-AFFILIATE-v3"]).nullable(),
  version: ref.nullable(), state: z.enum(["current", "pending", "unpublished", "unknown"]),
  reasonCodes: z.array(recruitmentReason).max(30),
}).strict().superRefine((value, ctx) => {
  const expected = value.route === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3";
  if (value.name !== null && value.name !== expected || value.state === "current" && (value.name === null || value.version === null) ||
    value.state === "unknown" && (value.name !== null || value.version !== null) || value.state !== "current" && value.reasonCodes.length === 0)
    ctx.addIssue({ code: "custom", message: "Model evidence must match checkout and explicitly identify any unknown or held state." });
});
export const recruitmentModelsSchema = z.array(recruitmentModelSchema).length(2).refine(models => new Set(models.map(model => model.route)).size === 2,
  "Both checkout routes require distinct source evidence or explicit unknowns.");
export const unknownRecruitmentModels = () => recruitmentModelsSchema.parse(["website", "tiktok-shop"].map(route => ({
  route, name: null, version: null, state: "unknown", reasonCodes: ["MODEL_SOURCE_UNKNOWN"],
})));
export const nativeRecruitmentBatchSchema = z.object({
  kind: z.literal("native-recruitment-batch"), ...sourceHeader, filters: recruitmentBatchFiltersSchema,
  batchId: ref, approval: nativeApprovalViewSchema, run: nativeRunViewSchema, models: recruitmentModelsSchema,
  rows: z.array(z.object({
    itemRef: ref, creatorRef: ref, source: z.enum(["social-cat", "tiktok"]), deal: z.enum(["affiliate", "historical"]),
    ownerRef: ref.nullable(), owner: reviewFieldSchema, deadline: instant.nullable(),
    membership: z.enum(["included", "held"]), holdReasons: z.array(recruitmentReason).max(30),
    recipient: reviewFieldSchema, product: reviewFieldSchema, terms: reviewFieldSchema,
  }).strict()).max(100),
  coverage: z.object({ returned: recruitmentCount.max(100), total: recruitmentCount.max(100), complete: z.boolean() }).strict(),
  owners: z.array(z.object({ ref, label: reviewFieldSchema }).strict()).max(100),
  capacity: z.array(recruitmentCapacitySchema).max(4), samples: z.array(sampleRequestViewSchema).max(100),
  forecastCommissionMinor: recruitmentCount.nullable(), forecastIsEarnedCap: z.literal(false),
  sourceLink: reviewLinkSchema, sourceEffect: z.literal("none"),
}).strict().superRefine((value, ctx) => {
  if (value.batchId !== value.filters.batchId || value.run.approvalRef !== value.approval.approvalRef ||
      value.run.manifestRef !== value.approval.manifestRef || value.coverage.returned !== value.rows.length ||
      value.coverage.total < value.rows.length || value.coverage.complete !== (value.coverage.total === value.rows.length) ||
      new Set(value.rows.map(row => row.itemRef)).size !== value.rows.length)
    ctx.addIssue({ code: "custom", message: "Batch membership, exact manifest and finite coverage must reconcile." });
});
export type NativeRecruitmentBatch = z.infer<typeof nativeRecruitmentBatchSchema>;
