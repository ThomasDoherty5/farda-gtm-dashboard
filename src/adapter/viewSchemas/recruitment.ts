/**
 * Runtime schemas for recruitmentQueue, invitationDraft, batchDetail, pipelineSummary and discoverySummary.
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
import { provenanceValueSchema } from "../contract";
import { count, countsByOwner, minorUnits, money, owner, percent, text, unknownMarker } from "./acquisitionPrimitives";

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

const invitationDraft = z.object({
  datasetKey: text,
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
});

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
  /** Only dispatch can be null: an inbound application has no outbound dispatch. Null is not applicable, never zero. */
  current: z.object(Object.fromEntries(CURRENT_STAGE_KEYS.map((k) => [k, k === "dispatch" ? count.nullable() : count])) as Record<(typeof CURRENT_STAGE_KEYS)[number], typeof count> & { dispatch: z.ZodNullable<typeof count> }),
  dispatch: z.object({ queued: count, toReconcile: count }),
  closed: z.object({ waiting: count, declined: count, expired: count }),
  sends: z.object({ approved: count, confirmed: count, uncertain: count, queued: count, replies: count, attempts: count, opportunities: count }),
  nativeMilestone: z.enum(["matched", "accepted"]),
  outcomes: z.object({ posts: count, comparablePosts: count, views: count, engagements: count, orders: count, fullyRefundedOrders: count, merchandise: money, refunds: money }),
});

const pipelineFilterKeys = z.enum(["source", "route", "network", "checkout", "window", "policy"]);
const pipelineSummary = z.object({
  datasetKey: text,
  cohort: z.object({ label: text, asOf: z.string().datetime(), timezone: text, grain: text }),
  filters: z.object({
    source: z.enum(["both", "social-cat", "tiktok-shop"]),
    /** Inbound applications are a separate cohort from outbound invitations. */
    route: z.enum(["outbound", "inbound"]),
    network: z.enum(["all", "instagram", "tiktok"]),
    checkout: z.enum(["all", "website", "tiktok-shop"]),
    window: z.enum(["sep-oct", "sep", "oct"]),
    policy: z.enum(["all", "policy-2026-09", "policy-2026-10"]),
  }),
  /** Filters set to a value the dataset cannot split. The counts do not change for them. */
  unsplit: z.array(pipelineFilterKeys),
  scaleMax: count,
  sources: z.array(sourceFacts),
});

/* ---------- pipelineBranches ---------- */

/** Terminal paths and optional branches. A null delivered count is unknown (no carrier receipt), never zero. */
const pipelineBranches = z.object({
  datasetKey: z.literal("pipeline-branches-demo"),
  cohort: text,
  sources: z.array(z.object({
    source: z.enum(["social-cat", "tiktok-shop"]),
    label: text,
    terminal: z.object({ declined: count, optOut: count, expired: count }),
    sample: z.object({ accepted: count, requested: count, notRequested: count, stockCostApproved: count, shipped: count, delivered: count.nullable() }),
    content: z.object({ terms: count, withObligation: count, withoutObligation: count, posted: count, due: count, overdue: count, postedVoluntarily: count, noneYet: count, trackingActive: count }),
  })),
  repeatCases: z.array(z.object({ handle: text, prior: z.enum(["declined", "optOut", "expired"]), source: z.enum(["social-cat", "tiktok-shop"]), repeatAllowed: z.boolean(), suppression: z.enum(["preserved", "permanent"]) })),
});

/* ---------- discoverySummary ---------- */

const discoverySummary = z.object({
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
}).superRefine((d, ctx) => {
  if (d.currentPhase >= d.phases.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentPhase"], message: "currentPhase must index a phase" });
  if (d.batch.eligible > d.batch.selected) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["batch", "eligible"], message: "Eligible cannot exceed selected" });
});

export const recruitmentViewSchemas: Record<string, z.ZodTypeAny> = {
  recruitmentQueue,
  invitationDraft,
  batchDetail,
  pipelineSummary,
  pipelineBranches,
  discoverySummary,
};
