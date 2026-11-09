import { nativeBulkViewSchema } from "../../creator-agent/bulk/views.ts";
/**
 * Runtime schemas for recruitmentQueue, invitationDraft, batchDetail, pipelineSummary, discoverySummary and sourcingPlan.
 *
 * Unknown versus zero: several fields are `number | null` in the fixtures, where null means unknown (pipeline
 * `reached` and `medianDays`, batch `nativeInvitations`). They accept null and never coerce it to 0. Fields that
 * the fixtures type as an "unknown" literal (invitation `quota`, batch `collaborationSlots`) accept only that
 * marker, so a bare number cannot pass for a figure nobody has read. Discovery's `liveCapacity` and `upfrontFee`
 * are contract provenance values: known zero (a $0 upfront fee) is value 0 with state known, and a known null
 * is rejected.
 *
 * Strictness: loose, except per-owner counts (a stray owner would vanish from totals) and the unknown markers.
 * Money-like fields use the non-negative integer minor-unit shapes from acquisitionPrimitives.
 *
 * Pipeline arrays are indexed by stage: `reached` and `medianDays` must hold exactly one entry per funnel stage
 * (10), and `current` must name every exclusive current-stage bucket (10).
 */
import { z } from "zod";
import { nativeInvitationViewSchema, nativeRecruitmentBatchSchema } from "../../creator-agent/recruitment/contract.ts";
import { scorecardPreviewSchema } from "../../creator-agent/scorecardPreview.ts";
import { livePipelineSchema } from "../../creator-agent/funnelContract.ts";
import { agentSourcingSchema, nativeRecruitmentViewSchema } from "../../creator-agent/readViews.ts";
import { provenanceValueSchema } from "../contract.ts";
import { count, countsByOwner, minorUnits, money, owner, percent, text, unknownMarker } from "./acquisitionPrimitives.ts";
import { sourcingPlanSchema } from "../../creator-agent/sourcing/contract.ts";

/* ---------- recruitmentQueue ---------- */

const publishing = z.enum(["instagram", "tiktok"]);
const queueRow = z.object({
  id: text,
  handle: text,
  assessment: text,
  state: text,
  network: z.enum(["Instagram", "TikTok", "Unconfirmed"]),
  route: z.enum(["inbound", "outbound"]),
  next: z.object({ label: text, to: z.enum(["assessment", "brief", "evidence"]) }),
});

const recruitmentQueue = z.object({
  datasetKey: text,
  filters: z.object({ networks: z.union([z.literal("both"), publishing]), route: z.enum(["queue", "inbound", "outbound"]) }),
  /** Historical planning allocation by primary publishing network. Not current stock. */
  allocation: z.object({ instagram: count, tiktok: count }),
  crossPostExtraSamples: count,
  queue: z.array(queueRow),
  plan: z.object({ name: text, price: text, usage: z.literal("unknown") }),
  draft: z.object({ recipient: text, reference: text, version: text }),
});

/* ---------- invitationDraft ---------- */

const demoInvitationDraft = z.object({
  datasetKey: z.literal("invitation-demo"),
  creators: z.array(z.object({ handle: text, suppression: z.enum(["clear", "suppressed"]), identity: z.literal("resolved") })),
  products: z.array(z.object({ name: text, listing: z.literal("unverified") })),
  program: z.object({ maxCommissionPct: percent, maxValidityDays: z.number().int().positive(), label: text }),
  priorScore: z.object({ model: text, value: z.number().int().min(0).max(100) }),
  /** Not read yet. A numeric quota is refused: the screen cannot tell a read zero from a missing read. */
  quota: unknownMarker,
  plannedSamples: count,
  draftVersion: text,
  automateInvitations: z.literal("off"),
  sampleRequest: z.object({ id: text, handle: text, nativeDeadline: text, lastRead: text }),
}).strict();

/** Native transport identity does not imply production evidence: sandbox test sources remain explicitly synthetic. */
const nativeProvenance = z.object({ kind: z.literal("source"), evidenceStage: z.enum(["synthetic", "source"]),
  observedAt: z.string().datetime({ offset: true }), eventAt: z.string().datetime({ offset: true }).nullable(),
  sourceId: z.string().min(1).nullable(), canonicalId: z.string().min(1).nullable(), provenanceRef: z.string().min(1),
}).strict();
function nativeRecord<T extends z.ZodRawShape, U extends z.UnknownKeysParam>(schema: z.ZodObject<T, U>, identity: string) {
  return schema.extend({ datasetKey: z.literal(identity), synthetic: z.boolean(), provenance: nativeProvenance }).strict().superRefine((value, ctx) => {
    const provenance = value.provenance;
    if (!provenance) {
      ctx.addIssue({ code: "custom", path: ["provenance"], message: "Native records require source provenance." });
      return;
    }
    if (value.synthetic !== (provenance.evidenceStage === "synthetic"))
      ctx.addIssue({ code: "custom", path: ["synthetic"], message: "Evidence stage and synthetic marker must agree." });
    if (provenance.eventAt && Date.parse(provenance.eventAt) > Date.parse(provenance.observedAt))
      ctx.addIssue({ code: "custom", path: ["provenance", "eventAt"], message: "A source event cannot follow its observation." });
  });
}

export const nativeInvitationDraftSchema = nativeRecord(demoInvitationDraft, "invitation-native");
const invitationDraft = z.union([nativeInvitationViewSchema, nativeInvitationDraftSchema, demoInvitationDraft]);

/* ---------- batchDetail ---------- */

const batchItem = z.object({
  id: text,
  handle: text,
  terms: text,
  evidence: text,
  next: text,
  state: z.enum(["confirmed", "queued", "running", "reconcile", "login", "paused", "canceled"]),
});

const batchDetail = z.object({
  datasetKey: text,
  batchId: text,
  version: text,
  paused: z.boolean(),
  items: z.array(batchItem).superRefine((items, ctx) => {
    if (new Set(items.map((i) => i.id)).size !== items.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Batch item ids must be unique" });
  }),
  held: z.array(z.object({ key: text, label: text, byOwner: countsByOwner })),
  /** TikTok sample requests. A decision counts only with TikTok's receipt; a denied route is an owner handoff, never a decision. */
  samples: z.array(z.object({ id: text, handle: text, product: text, units: count, route: z.enum(["api", "authorityDenied"]), state: z.enum(["pending", "approved", "declined", "handoff"]), receiptRef: text.nullable(), ownerRef: text.nullable() })),
  filters: z.object({ source: z.enum(["tiktok", "all"]), deal: z.enum(["affiliate", "all"]), owner: z.union([z.literal("all"), owner]) }),
  model: z.object({ label: text, status: z.literal("pending") }),
  capacity: z.object({
    /** Null is unknown, not zero. */
    nativeInvitations: count.nullable(),
    sampleUnits: count,
    sampleCostMinor: minorUnits,
    /** Unknown until the source is read. */
    collaborationSlots: z.null(),
  }),
});

/* ---------- pipelineSummary ---------- */

const STAGES = 10;
const CURRENT_STAGE_KEYS = ["videoReview", "evidenceHold", "approvalPending", "dispatch", "matchPending", "termsPending", "trackingSetup", "contentPending", "firstOrderPending", "generatingOrders"] as const;

const sourceFacts = z.object({
  source: z.enum(["social-cat", "tiktok-shop"]),
  label: text,
  /** Opportunities that reached each stage. Null is unknown, never zero. */
  reached: z.array(count.nullable()).length(STAGES),
  /** Median days from the previous stage. Null when timestamps are missing. */
  medianDays: z.array(z.number().nonnegative().nullable()).length(STAGES),
  /** Null where the bucket does not exist for the route (inbound has no outbound dispatch): N/A, never zero. */
  current: z.object(Object.fromEntries(CURRENT_STAGE_KEYS.map((k) => [k, count.nullable()])) as Record<(typeof CURRENT_STAGE_KEYS)[number], ReturnType<typeof count.nullable>>),
  dispatch: z.object({ queued: count, toReconcile: count }).nullable(),
  closed: z.object({ waiting: count, declined: count, expired: count }),
  sends: z.object({ approved: count, confirmed: count, uncertain: count, queued: count, replies: count, attempts: count, opportunities: count }).nullable(),
  nativeMilestone: z.enum(["matched", "accepted"]),
  outcomes: z.object({ posts: count, comparablePosts: count, views: count, engagements: count, orders: count, fullyRefundedOrders: count, merchandise: money, refunds: money }),
}).superRefine((v, ctx) => {
  // Outbound dispatch is N/A for the whole source or for none of it: a null bucket beside real send counts is a contradiction.
  const na = [v.current.dispatch === null, v.dispatch === null, v.sends === null];
  if (na.some((x) => x !== na[0])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "current.dispatch, dispatch and sends must all be null (no outbound route) or all be present", path: ["current", "dispatch"] });
});

const pipelineFilterKeys = z.enum(["source", "route", "network", "checkout", "window", "policy"]);
const pipelineSummary = z.object({
  datasetKey: text,
  cohort: z.object({ label: text, asOf: z.string().datetime(), timezone: text, grain: text }),
  filters: z.object({
    source: z.enum(["both", "social-cat", "tiktok-shop"]),
    network: z.enum(["all", "instagram", "tiktok"]),
    checkout: z.enum(["all", "website", "tiktok-shop"]),
    window: z.enum(["sep-oct", "sep", "oct"]),
    route: z.enum(["outbound", "inbound"]),
    policy: z.enum(["all", "policy-2026-09", "policy-2026-10"]),
  }),
  /** Filters set to a value the dataset cannot split. The counts do not change for them. */
  unsplit: z.array(pipelineFilterKeys),
  scaleMax: count,
  sources: z.array(sourceFacts),
});

/* ---------- pipelineBranches ---------- */

const source = z.enum(["social-cat", "tiktok-shop"]);
const pipelineBranches = z.object({
  datasetKey: text,
  cohort: text,
  sources: z.array(
    z.object({
      source,
      label: text,
      terminal: z.object({ declined: count, optOut: count, expired: count }),
      /** Delivered is null where no carrier receipt exists for the source: unknown, never zero. */
      sample: z.object({ accepted: count, requested: count, notRequested: count, stockCostApproved: count, shipped: count, delivered: count.nullable() }),
      content: z.object({ terms: count, withObligation: count, withoutObligation: count, posted: count, due: count, overdue: count, postedVoluntarily: count, noneYet: count, trackingActive: count }),
    }),
  ),
  repeatCases: z.array(z.object({ handle: text, prior: z.enum(["declined", "optOut", "expired"]), source, repeatAllowed: z.boolean(), suppression: z.enum(["preserved", "permanent"]) })),
});

/* ---------- discoverySummary ---------- */

const historicalDiscoverySummary = z.object({
  datasetKey: text,
  schedule: z.object({ label: text, context: text }),
  /** Unknown until the account is read. */
  liveCapacity: provenanceValueSchema(count),
  liveCapacityContext: text,
  model: z.object({ label: text, context: text }),
  /** Known zero for commission-only acquisition. The value is Money, so a bare number is refused. */
  upfrontFee: provenanceValueSchema(money),
  phases: z.array(z.object({ title: text, note: text })).min(1),
  currentPhase: count,
  capacityRows: z.array(z.object({ id: z.enum(["social-cat", "tiktok-shop", "shared"]), source: text, evidence: text, meaning: text, next: text })),
  batch: z.object({ batchId: text, selected: count, eligible: count, sampleUnits: count, sampleUnitCost: money, rateLabel: text }),
  /** The plan's versions. An unread source account is unknown, never a made-up id. */
  versions: z.object({ sourceAccount: provenanceValueSchema(text), icpVersion: text, policyVersion: text, accessStatus: text, scheduleStatus: z.enum(["draft", "active"]) }),
  steps: z.array(z.object({ title: text, count: count.nullable(), countLabel: text, owner: text, evidence: text, next: text })).min(1),
  identity: z.object({ surfaced: count, mergedDuplicates: count, suppressed: z.object({ optedOut: count, declinedRecently: count, existingRelationship: count }), selected: count }),
}).superRefine((d, ctx) => {
  if (d.currentPhase >= d.phases.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentPhase"], message: "currentPhase must index a phase" });
  if (d.batch.eligible > d.batch.selected) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["batch", "eligible"], message: "Eligible cannot exceed selected" });
});

const discoverySummary = z.union([historicalDiscoverySummary, agentSourcingSchema]);

export const recruitmentViewSchemas: Record<string, z.ZodTypeAny> = {
  recruitmentQueue: z.union([nativeRecruitmentViewSchema, recruitmentQueue]),
  invitationDraft,
  batchDetail: z.union([nativeBulkViewSchema,nativeRecruitmentBatchSchema, scorecardPreviewSchema, batchDetail]),
  pipelineSummary: z.union([livePipelineSchema, pipelineSummary]),
  pipelineBranches: z.union([livePipelineSchema, pipelineBranches]),
  discoverySummary,
  /** The served daily plan detail (THO-287). Strict: unknown counts carry a reason and unlike capacity units never merge. */
  sourcingPlan: sourcingPlanSchema,
};
