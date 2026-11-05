import { z } from "zod";
import { digest } from "./config.ts";

export const PORTFOLIO_VERSION = "portfolio.v1";
const ref = z.string().trim().min(1).max(240);
const timestamp = z.string().datetime({ offset: true });
const refs = z.array(ref).min(1).max(100);
const count = z.number().int().nonnegative().safe();
const observedNumber = z.object({ value: z.number().finite().nullable(), evidenceRefs: z.array(ref).max(100) }).strict()
  .refine((value) => value.value === null || value.evidenceRefs.length > 0, "Known values require source evidence");
const observedFlag = z.object({ value: z.boolean().nullable(), evidenceRefs: z.array(ref).max(100) }).strict()
  .refine((value) => value.value === null || value.evidenceRefs.length > 0, "Known flags require source evidence");
const providerUsage = z.object({ quotaId: ref, unit: ref, quantity: count }).strict();

const collaboration = z.object({
  collaborationId: ref, campaignId: ref, briefRevision: ref, deliverableIds: z.array(ref).max(100),
  posts: z.array(z.object({ postId: ref, publishedAt: timestamp }).strict()).max(100), evidenceRefs: refs,
  acceptedUsableAssets: observedNumber.refine((v) => v.value === null || Number.isInteger(v.value) && v.value >= 0),
  deliveryReliable: observedFlag, revisionHistoryRefs: z.array(ref).max(100),
  rightsUsable: observedFlag,
  organic: z.object({ definition: ref, window: ref, value: observedNumber, paidAmplified: z.boolean().nullable() }).strict(),
  paid: z.object({ definition: ref, window: ref, validatedPerformer: observedFlag }).strict(),
  retainedContribution: z.object({ currency: z.string().length(3), maturity: z.enum(["mature", "immature", "unknown"]), cents: observedNumber.refine((v) => v.value === null || Number.isSafeInteger(v.value)), adjustmentRefs: z.array(ref).max(100) }).strict(),
}).strict();
const creator = z.object({
  creatorId: ref, identityRef: ref, ownerRef: ref,
  contactEligible: observedFlag, suppressed: observedFlag, inactive: observedFlag,
  outstandingObligationRefs: z.array(ref).max(100), earnedCommissionRefs: z.array(ref).max(100),
  collaborations: z.array(collaboration).max(50),
  next: z.object({
    briefRef: ref, expectedDeliverables: z.array(z.object({ deliverableId: ref, format: ref, quantity: count.positive() }).strict()).min(1).max(50),
    dueAt: timestamp, nextReviewAt: timestamp,
    alreadyHasUsableProduct: observedFlag,
    sampleUnits: count.nullable(), sampleCashCents: count.nullable(), reviewSlots: count.nullable(), approvalSlots: count.nullable(),
    providerUsage: z.array(providerUsage).max(20),
  }).strict(),
}).strict();
const capacity = z.object({ available: count.nullable(), outstanding: count.nullable() }).strict();
export const portfolioPacketSchema = z.object({
  schemaVersion: z.literal(PORTFOLIO_VERSION), evidenceRevision: ref, policyRef: ref,
  programId: ref, campaignId: ref, currency: z.string().length(3), objective: z.enum(["usable-content", "retained-sales", "paid-creative"]),
  reviewWindow: z.object({ start: timestamp, end: timestamp }).strict(),
  trigger: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("weekly-performance-review"), eventId: ref, sourceRef: ref }).strict(),
    z.object({ kind: z.literal("approved-on-demand"), eventId: ref, approvalRef: ref }).strict(),
  ]),
  comparison: z.object({ publicationAgeMinDays: count, publicationAgeMaxDays: count, organicDefinition: ref, organicWindow: ref, paidDefinition: ref, paidWindow: ref }).strict(),
  capacity: z.object({
    maximumCreators: capacity, sampleUnits: capacity, sampleCashCents: capacity, reviewSlots: capacity, approvalSlots: capacity,
    providerQuotas: z.array(z.object({ quotaId: ref, unit: ref, available: count.nullable(), outstanding: count.nullable() }).strict()).max(30),
    evidenceRefs: refs,
  }).strict(),
  creators: z.array(creator).max(100),
}).strict().superRefine((packet, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (Date.parse(packet.reviewWindow.start) >= Date.parse(packet.reviewWindow.end)) issue("Review window must increase");
  if (packet.comparison.publicationAgeMinDays > packet.comparison.publicationAgeMaxDays) issue("Comparison age range must increase");
  if (new Set(packet.creators.map((c) => c.creatorId)).size !== packet.creators.length) issue("Duplicate creator");
  if (new Set(packet.creators.map((c) => c.identityRef)).size !== packet.creators.length) issue("Duplicate canonical creator identity");
  if (new Set(packet.capacity.providerQuotas.map((q) => q.quotaId)).size !== packet.capacity.providerQuotas.length) issue("Duplicate quota");
  const collaborationIds = packet.creators.flatMap((c) => c.collaborations.map((x) => x.collaborationId));
  if (new Set(collaborationIds).size !== collaborationIds.length) issue("Duplicate collaboration");
  const postIds = packet.creators.flatMap((c) => c.collaborations.flatMap((x) => x.posts.map((p) => p.postId)));
  if (new Set(postIds).size !== postIds.length) issue("A publication cannot be counted in multiple collaboration aggregates");
  for (const c of packet.creators) {
    if (c.next.alreadyHasUsableProduct.value !== true && c.next.sampleUnits !== null && c.next.sampleUnits === 0) issue("A known new sample allocation must contain at least one unit");
    if (Date.parse(c.next.dueAt) <= Date.parse(packet.reviewWindow.end) || Date.parse(c.next.nextReviewAt) <= Date.parse(packet.reviewWindow.end)) issue("Next due/review dates must follow the review window");
    if (new Set(c.next.expectedDeliverables.map((d) => d.deliverableId)).size !== c.next.expectedDeliverables.length) issue("Duplicate proposed deliverable");
    if (new Set(c.next.providerUsage.map((q) => q.quotaId)).size !== c.next.providerUsage.length) issue("Duplicate candidate quota");
    if (c.collaborations.some((x) => x.retainedContribution.currency !== packet.currency)) issue("Contribution currencies must match the review currency");
    for (const x of c.collaborations) {
      if (new Set(x.posts.map((post) => post.postId)).size !== x.posts.length) issue("Duplicate publication");
      if (x.posts.some((post) => Date.parse(post.publishedAt) > Date.parse(packet.reviewWindow.end))) issue("Future publications cannot support this review");
    }
  }
});
export type PortfolioPacket = z.infer<typeof portfolioPacketSchema>;
export const portfolioActionSchema = z.enum(["renew", "new-brief", "observe", "stop-new-invitations", "close"]);
export type PortfolioAction = z.infer<typeof portfolioActionSchema>;
export type PortfolioSegment = "new-test" | "evidence-immature" | "reliable-content-producer" | "retained-sales-performer" | "paid-creative-performer" | "repeat-partner" | "inactive-restricted";
export type PortfolioRecommendation = {
  key: string; creatorId: string; ownerRef: string; segments: PortfolioSegment[]; action: PortfolioAction;
  rationale: string; reasonCodes: string[]; uncertainty: string[]; evidenceRefs: string[]; nextReviewAt: string;
  comparableCollaborationIds: string[]; objectiveValue: number | null;
  outstandingObligationRefs: string[]; earnedCommissionRefs: string[];
};
export type PortfolioProposal = {
  schemaVersion: typeof PORTFOLIO_VERSION; reviewKey: string; policyRef: string; recommendations: PortfolioRecommendation[];
  cohort: { state: "proposal-only"; selectedCreatorIds: string[]; held: { creatorId: string; reasons: string[] }[];
    forecast: { creators: number; sampleUnits: number; sampleCashCents: number; reviewSlots: number; approvalSlots: number; providerUsage: { quotaId: string; unit: string; quantity: number }[] };
    candidates: { creatorId: string; briefRef: string; expectedDeliverables: PortfolioPacket["creators"][number]["next"]["expectedDeliverables"]; dueAt: string; requiresNewSample: boolean | null }[];
  };
  safeguards: { dispatchAuthorized: false; modelPolicyChanged: false; attributionIsIncrementality: false; existingObligationsPreserved: true };
};
export const portfolioReviewKey = (packet: Pick<PortfolioPacket, "programId" | "reviewWindow">) => digest({ programId: packet.programId, reviewWindow: packet.reviewWindow });

/** Reviewed operational evidence only. No new score weights, commercial tiers, spend or provider actions. */
export function reviewPortfolio(raw: unknown): PortfolioProposal {
  const packet = portfolioPacketSchema.parse(raw);
  const reviewKey = portfolioReviewKey(packet);
  const recommendations = packet.creators.map((c): PortfolioRecommendation => {
    const comparable = c.collaborations.filter((x) => {
      if (!x.posts.length || x.campaignId !== packet.campaignId) return false;
      // A collaboration aggregate is comparable only when every contributing publication fits the window.
      return x.posts.every((post) => {
        const age = (Date.parse(packet.reviewWindow.end) - Date.parse(post.publishedAt)) / 86_400_000;
        return age >= packet.comparison.publicationAgeMinDays && age <= packet.comparison.publicationAgeMaxDays;
      });
    });
    const content = comparable.filter((x) => x.acceptedUsableAssets.value !== null && x.acceptedUsableAssets.value > 0 && x.rightsUsable.value === true && x.deliveryReliable.value === true);
    const sales = comparable.filter((x) => x.retainedContribution.maturity === "mature" && x.retainedContribution.cents.value !== null);
    const paid = comparable.filter((x) => x.paid.definition === packet.comparison.paidDefinition && x.paid.window === packet.comparison.paidWindow && x.paid.validatedPerformer.value === true && x.rightsUsable.value === true);
    const retained = sales.length ? sales.reduce((sum, x) => sum + x.retainedContribution.cents.value!, 0) : null;
    const immature = comparable.some((x) => x.retainedContribution.maturity !== "mature");
    const segments: PortfolioSegment[] = [];
    if (c.collaborations.length === 0 || c.collaborations.every((x) => x.posts.length === 0)) segments.push("new-test");
    if (immature || comparable.length === 0) segments.push("evidence-immature");
    if (content.length) segments.push("reliable-content-producer");
    if (retained !== null && retained > 0) segments.push("retained-sales-performer");
    if (paid.length) segments.push("paid-creative-performer");
    if (c.collaborations.length > 1) segments.push("repeat-partner");
    const restricted = c.suppressed.value === true || c.contactEligible.value === false;
    if (restricted || c.inactive.value === true) segments.push("inactive-restricted");
    const uncertainty: string[] = [];
    if (c.contactEligible.value === null || c.suppressed.value === null || c.inactive.value === null) uncertainty.push("CONTACT_STATE_UNKNOWN");
    if (!comparable.length) uncertainty.push("NO_COMPARABLE_PUBLISHED_EVIDENCE");
    if (immature) uncertainty.push("RETAINED_CONTRIBUTION_NOT_MATURE");
    if (comparable.some((x) => x.acceptedUsableAssets.value === null || x.deliveryReliable.value === null || x.rightsUsable.value === null)) uncertainty.push("CONTENT_EVIDENCE_INCOMPLETE");
    if (comparable.some((x) => x.organic.paidAmplified !== false)) uncertainty.push("ORGANIC_PAID_CONTEXT_MIXED_OR_UNKNOWN");
    if (comparable.some((x) => x.organic.definition !== packet.comparison.organicDefinition || x.organic.window !== packet.comparison.organicWindow)) uncertainty.push("ORGANIC_DEFINITIONS_NOT_COMPARABLE");
    let objectiveValue: number | null = null;
    if (packet.objective === "usable-content") objectiveValue = comparable.length && comparable.every((x) => x.acceptedUsableAssets.value !== null && x.rightsUsable.value !== null && x.deliveryReliable.value !== null) ? content.reduce((sum, x) => sum + x.acceptedUsableAssets.value!, 0) : null;
    if (packet.objective === "retained-sales") objectiveValue = comparable.length && sales.length === comparable.length && !immature ? retained : null;
    if (packet.objective === "paid-creative") objectiveValue = comparable.length && comparable.every((x) => x.paid.definition === packet.comparison.paidDefinition && x.paid.window === packet.comparison.paidWindow && x.paid.validatedPerformer.value !== null && x.rightsUsable.value !== null) ? paid.length : null;
    let action: PortfolioAction = "observe";
    const reasonCodes: string[] = [];
    if (restricted) { action = "stop-new-invitations"; reasonCodes.push("CONTACT_RESTRICTED"); }
    else if (c.inactive.value === true) { action = "close"; reasonCodes.push("REVIEWED_INACTIVE"); }
    else if (uncertainty.includes("CONTACT_STATE_UNKNOWN")) reasonCodes.push("CONTACT_REVIEW_REQUIRED");
    else if (objectiveValue === null) reasonCodes.push("OBJECTIVE_EVIDENCE_NOT_READY");
    else if (objectiveValue > 0) { action = "renew"; reasonCodes.push("OBSERVED_OBJECTIVE_SUPPORT"); }
    else if (content.length) { action = "new-brief"; reasonCodes.push("CONTENT_STRENGTH_WITHOUT_OBJECTIVE_RESULT"); }
    else reasonCodes.push("NO_POSITIVE_COMPARABLE_OBJECTIVE_EVIDENCE");
    if (c.outstandingObligationRefs.length) reasonCodes.push("EXISTING_OBLIGATIONS_REMAIN_OPEN");
    const evidenceRefs = [...new Set([c.identityRef, ...c.contactEligible.evidenceRefs, ...c.suppressed.evidenceRefs, ...c.inactive.evidenceRefs,
      ...c.collaborations.flatMap((x) => [...x.evidenceRefs, ...x.acceptedUsableAssets.evidenceRefs, ...x.deliveryReliable.evidenceRefs, ...x.revisionHistoryRefs, ...x.rightsUsable.evidenceRefs, ...x.organic.value.evidenceRefs, ...x.paid.validatedPerformer.evidenceRefs, ...x.retainedContribution.cents.evidenceRefs, ...x.retainedContribution.adjustmentRefs])])];
    const rationale = action === "renew" ? "Comparable reviewed evidence supports the stated objective; a renewal remains a proposal subject to capacity and the exact founder decision."
      : action === "new-brief" ? "Accepted usable content is present but mature evidence does not show a positive result for this objective; propose a revised brief for review."
        : action === "stop-new-invitations" ? "Reviewed contact restrictions prevent new invitations; existing deliverables and earned commissions remain intact."
          : action === "close" ? "Reviewed inactivity supports closing this portfolio proposal; historical records and open obligations remain intact."
            : "Observe until comparable objective evidence and contact eligibility are sufficient; unknown or immature evidence is not treated as failure.";
    return { key: digest({ reviewKey, creatorId: c.creatorId }), creatorId: c.creatorId, ownerRef: c.ownerRef, segments, action, rationale, reasonCodes, uncertainty, evidenceRefs, nextReviewAt: c.next.nextReviewAt, comparableCollaborationIds: comparable.map((x) => x.collaborationId), objectiveValue, outstandingObligationRefs: c.outstandingObligationRefs, earnedCommissionRefs: c.earnedCommissionRefs };
  });
  // Unknown capacities remain unavailable. Forecasts deduct outstanding commitments, never become reservations.
  const remaining = (value: z.infer<typeof capacity>) => value.available === null || value.outstanding === null ? null : Math.max(0, value.available - value.outstanding);
  const budgets = { creators: remaining(packet.capacity.maximumCreators), sampleUnits: remaining(packet.capacity.sampleUnits), sampleCashCents: remaining(packet.capacity.sampleCashCents), reviewSlots: remaining(packet.capacity.reviewSlots), approvalSlots: remaining(packet.capacity.approvalSlots) };
  const quotas = new Map(packet.capacity.providerQuotas.map((q) => [q.quotaId, { unit: q.unit, remaining: remaining(q) }]));
  const forecast: PortfolioProposal["cohort"]["forecast"] = { creators: 0, sampleUnits: 0, sampleCashCents: 0, reviewSlots: 0, approvalSlots: 0, providerUsage: [] };
  const held: PortfolioProposal["cohort"]["held"] = [];
  const selectedCreatorIds: string[] = [];
  // Only comparable objective evidence is ranked; ties use a stable identity, never hidden score weights.
  const ranked = [...recommendations].sort((a, b) => (b.objectiveValue ?? -Infinity) - (a.objectiveValue ?? -Infinity) || a.creatorId.localeCompare(b.creatorId));
  for (const recommendation of ranked) {
    const c = packet.creators.find((x) => x.creatorId === recommendation.creatorId)!;
    const reasons: string[] = [];
    if (recommendation.action !== "renew" && recommendation.action !== "new-brief") reasons.push("RECOMMENDATION_NOT_A_COHORT_CANDIDATE");
    if (c.next.alreadyHasUsableProduct.value === null) reasons.push("PRODUCT_POSSESSION_UNKNOWN");
    const costs = { creators: 1, sampleUnits: c.next.alreadyHasUsableProduct.value === true ? 0 : c.next.sampleUnits, sampleCashCents: c.next.alreadyHasUsableProduct.value === true ? 0 : c.next.sampleCashCents, reviewSlots: c.next.reviewSlots, approvalSlots: c.next.approvalSlots };
    for (const key of Object.keys(costs) as (keyof typeof costs)[]) {
      if (costs[key] === null || costs[key]! > 0 && budgets[key] === null) reasons.push(`CAPACITY_UNKNOWN:${key}`);
      else if (costs[key]! > budgets[key]!) reasons.push(`CAPACITY_EXCEEDED:${key}`);
    }
    for (const usage of c.next.providerUsage) {
      const quota = quotas.get(usage.quotaId);
      if (!quota || quota.unit !== usage.unit || usage.quantity > 0 && quota.remaining === null) reasons.push(`QUOTA_UNKNOWN_OR_UNIT_MISMATCH:${usage.quotaId}`);
      else if (quota.remaining !== null && usage.quantity > quota.remaining) reasons.push(`QUOTA_EXCEEDED:${usage.quotaId}`);
    }
    if (reasons.length) { held.push({ creatorId: c.creatorId, reasons }); continue; }
    selectedCreatorIds.push(c.creatorId);
    for (const key of Object.keys(costs) as (keyof typeof costs)[]) { if (budgets[key] !== null) budgets[key]! -= costs[key]!; forecast[key] += costs[key]!; }
    for (const usage of c.next.providerUsage) {
      if (quotas.get(usage.quotaId)!.remaining !== null) quotas.get(usage.quotaId)!.remaining! -= usage.quantity;
      const existing = forecast.providerUsage.find((x) => x.quotaId === usage.quotaId);
      if (existing) existing.quantity += usage.quantity;
      else forecast.providerUsage.push({ ...usage });
    }
  }
  return { schemaVersion: PORTFOLIO_VERSION, reviewKey, policyRef: packet.policyRef, recommendations,
    cohort: { state: "proposal-only", selectedCreatorIds, held, forecast, candidates: packet.creators.map((c) => ({ creatorId: c.creatorId, briefRef: c.next.briefRef, expectedDeliverables: c.next.expectedDeliverables, dueAt: c.next.dueAt, requiresNewSample: c.next.alreadyHasUsableProduct.value === null ? null : !c.next.alreadyHasUsableProduct.value })) },
    safeguards: { dispatchAuthorized: false, modelPolicyChanged: false, attributionIsIncrementality: false, existingObligationsPreserved: true } };
}
