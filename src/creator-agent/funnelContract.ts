import { z } from "zod";

export const FUNNEL_VERSION = "evt-inv.v1" as const;
const id = z.string().trim().min(1).max(240);
const iso = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const metric = z.number().finite().nullable();
const nativeLink = z
  .string()
  .url()
  .max(1500)
  .refine((v) => /^https:\/\//.test(v), "HTTPS evidence link required");
const sourceRef = z
  .object({
    source: id,
    accountId: id,
    sourceId: id.nullable(),
    url: nativeLink.nullable(),
    canonicalId: id.nullable(),
    identityState: z.enum(["resolved", "unresolved"]),
    provenanceRef: id,
  })
  .strict();
export const eventTypes = [
  "discovered",
  "directReviewed",
  "qualified",
  "approval",
  "queued",
  "attempt",
  "uncertain",
  "confirmedSent",
  "reply",
  "matched",
  "terms",
  "tracking",
  "sampleRequested",
  "noSample",
  "sampleApproved",
  "sampleShipped",
  "sampleDelivered",
  "briefAccepted",
  "productionBlocked",
  "productionSubmitted",
  "contentAccepted",
  "publicationPlanned",
  "scheduled",
  "published",
  "removed",
  "retainedOrder",
  "refund",
  "settled",
  "paid",
  "review",
  "repeatEligible",
  "repeatParticipation",
  "declined",
  "optOut",
  "expired",
  "adAuthorized",
  "legacyPayable",
  "cost",
  "sourceOutage",
  "unknownState",
  "postMetrics",
] as const;
export type FunnelType = (typeof eventTypes)[number];
export const expenseBuckets = [
  "task",
  "model",
  "runtime",
  "provider",
  "orderProduct",
  "orderFulfillment",
  "ads",
  "rewards",
  "sampleProduct",
  "sampleShipping",
  "commissions",
  "refunds",
  "founderMinutes",
] as const;
const eventShape = z
  .object({
    schemaVersion: z.literal(FUNNEL_VERSION),
    eventId: id,
    eventType: z.enum(eventTypes),
    creatorRef: sourceRef,
    relationshipRef: sourceRef.nullable(),
    collaborationRef: sourceRef.nullable(),
    campaignCohortRef: sourceRef,
    sourceAccount: sourceRef,
    acquisitionRef: sourceRef.optional(),
    opportunityId: id,
    cohortStart: iso,
    maturationAt: iso.nullable(),
    route: z.enum(["inbound", "outbound"]),
    network: z.enum(["instagram", "tiktok", "other", "unknown"]),
    checkout: z.enum(["website", "tiktok-shop", "unknown"]),
    nativeActorRole: id,
    nativeActionKind: id,
    policyOfferApprovalVersions: z.object({ policy: id, offer: id.nullable(), approval: id.nullable() }).strict(),
    occurredAt: iso.nullable(),
    observedAt: iso,
    sourceState: id.nullable(),
    evidenceRef: z
      .object({
        provenanceRef: id,
        version: id,
        method: id,
        access: z.enum(["verified", "partial", "denied", "unavailable"]),
        url: nativeLink.nullable(),
        definition: id,
        unit: id,
        window: id.nullable(),
      })
      .strict(),
    ingestIdentity: z.object({ nativeId: id.nullable(), fingerprint: id.nullable(), sourceVersion: id }).strict(),
    correctsEventId: id.nullable().default(null),
    details: z
      .object({
        owner: id.nullable().optional(),
        blockers: z.array(id).max(25).default([]),
        nextAction: id.nullable().optional(),
        deliverableId: id.optional(),
        postId: id.optional(),
        creativeId: id.optional(),
        reviewId: id.optional(),
        orderId: id.optional(),
        settlementId: id.optional(),
        runId: id.optional(),
        obligation: z.enum(["required", "voluntary", "unknown"]).optional(),
        dueAt: iso.nullable().optional(),
        retainedMinor: count.nullable().optional(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        attributionVersion: id.optional(),
        attributionWindow: id.optional(),
        newCustomer: z.boolean().nullable().optional(),
        amountMinor: count.nullable().optional(),
        basis: z.enum(["accrual", "cash"]).optional(),
        bucket: z.enum(expenseBuckets).optional(),
        views: count.nullable().optional(),
        engagements: count.nullable().optional(),
        quotaPeriod: id.nullable().optional(),
        quotaLimit: count.nullable().optional(),
        identityCrosswalk: z
          .object({ fromSource: id, fromId: id, canonicalId: id, provenanceRef: id })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export const funnelEventSchema = eventShape.superRefine((e, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!e.campaignCohortRef.canonicalId && !e.campaignCohortRef.sourceId) fail("Missing cohort identity");
  if (!e.ingestIdentity.nativeId && !e.ingestIdentity.fingerprint)
    fail("Missing source identity or controlled crosswalk");
  if (!e.creatorRef.canonicalId && !e.creatorRef.sourceId && !e.ingestIdentity.fingerprint)
    fail("Missing creator crosswalk");
  if (e.eventType === "refund" && e.details.retainedMinor == null) fail("Refund requires known retained order balance");
  if (e.occurredAt && Date.parse(e.occurredAt) > Date.parse(e.observedAt)) fail("Occurrence after observation");
  if (e.maturationAt && Date.parse(e.maturationAt) < Date.parse(e.cohortStart)) fail("Maturation before cohort");
  if (!["sourceOutage", "unknownState"].includes(e.eventType) && e.evidenceRef.access !== "verified")
    fail("Confirmed fact requires verified provenance");
  if (e.eventType === "sourceOutage" && e.evidenceRef.access === "verified") fail("Outage needs an access limitation");
  if (e.route === "inbound" && ["queued", "attempt", "uncertain", "confirmedSent"].includes(e.eventType))
    fail("Inbound applications have no outbound invitation");
  if (["terms", "briefAccepted"].includes(e.eventType) && !e.policyOfferApprovalVersions.offer)
    fail("Accepted terms need an exact offer version");
  if (
    [
      "briefAccepted",
      "contentAccepted",
      "productionSubmitted",
      "productionBlocked",
      "publicationPlanned",
      "scheduled",
    ].includes(e.eventType) &&
    !e.details.deliverableId
  )
    fail("Deliverable required");
  if (["published", "removed", "postMetrics"].includes(e.eventType) && !e.details.postId) fail("Native post required");
  if (["review", "repeatEligible", "repeatParticipation"].includes(e.eventType) && !e.details.reviewId)
    fail("Review required");
  if (
    ["retainedOrder", "refund"].includes(e.eventType) &&
    (!e.details.orderId || !e.details.attributionVersion || !e.details.attributionWindow || !e.details.currency)
  )
    fail("Canonical attributed order, unit and window required");
  if (
    e.eventType === "cost" &&
    (!e.details.bucket || !e.details.basis || (e.details.bucket !== "founderMinutes" && !e.details.currency))
  )
    fail("Cost bucket, basis and unit required");
  if (e.eventType === "settled" && !e.details.settlementId) fail("Settlement identity required");
});
export type FunnelEvent = z.infer<typeof funnelEventSchema>;
export const funnelEnvelopeSchema = z
  .object({
    jobId: id,
    jobVersion: id,
    mode: z.enum(["observe", "reconcile"]),
    actor: z.object({ id, role: id }).strict(),
    accountRef: sourceRef,
    policyVersion: id,
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: id,
    correlationId: id,
    requestedAt: iso,
    deadline: iso.nullable(),
    checkpoint: z.record(z.string(), id).nullable(),
    event: funnelEventSchema,
  })
  .strict();
export type FunnelEnvelope = z.infer<typeof funnelEnvelopeSchema>;
export const funnelFilterSchema = z
  .object({
    source: id.optional(),
    account: id.optional(),
    route: z.enum(["inbound", "outbound"]).optional(),
    network: z.enum(["instagram", "tiktok", "other", "unknown"]).optional(),
    checkout: z.enum(["website", "tiktok-shop", "unknown"]).optional(),
    cohort: id.optional(),
    start: iso.optional(),
    end: iso.optional(),
    asOf: iso.optional(),
    policy: id.optional(),
    offer: id.optional(),
    opportunity: id.optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.start && f.end && Date.parse(f.end) <= Date.parse(f.start))
      ctx.addIssue({ code: "custom", message: "Cohort end must follow start" });
  });
export type FunnelFilters = z.infer<typeof funnelFilterSchema>;
export const stages = [
  "discovered",
  "directReviewed",
  "qualified",
  "approval",
  "confirmedSent",
  "matched",
  "terms",
  "tracking",
  "published",
  "retainedOrder",
] as const;
export const stageNames: Record<(typeof stages)[number], string> = {
  discovered: "Discovered",
  directReviewed: "Directly reviewed",
  qualified: "Qualified",
  approval: "Approved",
  confirmedSent: "Confirmed invitation",
  matched: "Native match / acceptance",
  terms: "Exact terms accepted",
  tracking: "Tracking active",
  published: "Verified publication",
  retainedOrder: "Retained order",
};
const stage = z.object({
  key: z.enum(stages),
  reached: count,
  eligible: count.nullable(),
  advanced: count.nullable(),
  medianDays: metric,
  knownPairs: count,
});
const quantity = z.object({
  name: id,
  value: metric,
  unit: id,
  denominator: count.nullable(),
  reason: z.string().nullable(),
});
const facts = z.object({
  eventId: id,
  type: z.enum(eventTypes),
  occurredAt: iso.nullable(),
  observedAt: iso,
  evidence: id,
  url: nativeLink.nullable(),
  version: id,
  nativeAction: id,
  nativeActor: id,
  runId: id.nullable(),
  deliverable: id.nullable(),
  post: id.nullable(),
  review: id.nullable(),
  attribution: id.nullable(),
  window: id.nullable(),
  newCustomer: z.boolean().nullable(),
});
const queue = z.object({
  id,
  creator: id,
  source: id,
  account: id,
  route: z.enum(["inbound", "outbound"]),
  stage: id,
  owner: id.nullable(),
  ageDays: metric,
  blockers: z.array(id),
  primary: id.nullable(),
  nextAction: id,
  quotaPeriod: id.nullable(),
  quotaLimit: count.nullable(),
  facts: z.array(facts),
});
export const livePipelineSchema = z
  .object({
    datasetKey: z.literal("funnel-ledger"),
    projectionVersion: z.literal(FUNNEL_VERSION),
    asOf: iso,
    timezone: z.literal("UTC"),
    context: z.literal("scoped observations"),
    coverage: z.object({
      events: count,
      opportunities: count,
      creators: count,
      mature: count,
      immature: count,
      unknownMaturity: count,
      incomplete: z.boolean(),
      missingTimes: count,
      unresolvedIdentity: count,
      unavailable: count,
    }),
    milestones: z.array(stage),
    queue: z.array(queue),
    queueCounts: z.record(id, count),
    exclusions: z.record(id, count),
    sends: z.object({
      attempts: count,
      recipients: count,
      confirmed: count,
      uncertain: count,
      queued: count,
      replies: count,
      matched: count,
    }),
    lifecycle: z.array(quantity),
    economics: z.array(quantity),
    outcomes: z.array(quantity),
  })
  .strict();
export type LivePipeline = z.infer<typeof livePipelineSchema>;
