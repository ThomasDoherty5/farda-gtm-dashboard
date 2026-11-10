/**
 * Runtime schemas for assessmentRecord (saved current runs and historical v2 scorecards) and offerDraft.
 *
 * Historical kinds are content-v2, tiktok-commerce-v2 and sc-commerce-v2. These are read-only,
 * labeled snapshots of prior proposed models. A criterion `rating` is an integer 0 to 5 or null; null means the
 * evidence is missing and is never read as 0. `coveragePct` follows the same rule. The empty-filter fixture
 * returns `data: null`, which the response envelope allows, so it is not part of this data schema.
 * Current creator-v3 records use the shared agent schema and identify an exact saved run.
 *
 * Strictness: the offer `payload` is strict. It holds every commercial term (commission, upfront fee,
 * compensation type, sample shipping). A stripped unknown key there could hide a term nobody reviewed, such as a
 * guaranteed fee, so an unexpected key fails the whole record. Whether the terms are allowed (commission-only,
 * zero upfront fee) is the server's policy decision and is not decided by this shape.
 */
import { z } from "zod";
import { offerRecordSchema, rewardsRecordSchema, offerSaveRecoverySchema } from "@/creator-agent/offers/contract";
import { agentAssessmentRecordSchema } from "@/creator-agent/readViews";
import { commercialEligibilityViewSchema } from "@/creator-agent/commercialPolicy/views";
import { calendarDate, count, instant, minorUnits, percent, text } from "./acquisitionPrimitives";

const tone = z.enum(["success", "violet", "warning", "neutral"]);
/** An integer 0 to 5, or null when the evidence is missing. */
const rating = z.number().int().min(0).max(5).nullable();
const criterion = z.object({ label: text, rating, weight: percent });
const history = z.array(z.object({ version: text, model: text, policy: text, offer: text, at: calendarDate, reason: text }));
const coveragePct = percent.nullable();

/** What an assessment was made against, and what is current. A difference in media, terms or policy invalidates readiness. */
const basis = z.object({ media: text, terms: text, policy: text });

const scorecard = z.object({
  kind: z.enum(["content-v2", "tiktok-commerce-v2"]),
  assessmentId: text,
  creatorId: text,
  handle: text,
  modelId: text,
  title: text,
  subtitle: text,
  historicalNote: text,
  coveragePct,
  criteria: z.array(criterion).min(1),
  evidence: z.array(z.object({ title: text, headline: text, note: text, observed: text })),
  gates: z.array(z.object({ label: text, badge: text, tone })),
  decisionNote: text,
  modelNote: text,
  history,
  assessedBasis: basis.optional(),
  currentBasis: basis.optional(),
});

const commerceScorecard = z.object({
  kind: z.literal("sc-commerce-v2"),
  assessmentId: text,
  creatorId: text,
  handle: text,
  route: text,
  coveragePct,
  /** The independent CONTENT-v2 score, shown beside commerce and never averaged with it. */
  contentScore: percent,
  criteria: z.array(criterion).min(1),
  evidenceRows: z.array(z.object({ evidence: text, window: text, coverage: text, action: text, target: z.enum(["evidence", "cohort", "offer"]) })),
  gates: z.array(z.object({ badge: text, tone, title: text, detail: text })),
  history,
  assessedBasis: basis.optional(),
  currentBasis: basis.optional(),
});

const historicalAssessmentRecord = z.discriminatedUnion("kind", [scorecard.extend({ kind: z.literal("content-v2") }), scorecard.extend({ kind: z.literal("tiktok-commerce-v2") }), commerceScorecard]);
const assessmentRecord = z.union([historicalAssessmentRecord, agentAssessmentRecordSchema]);

export const offerDraftPayloadSchema = z.object({
  commissionPct: z.number().min(0).max(100),
  eligibleBase: z.literal("eligibleMerchandise"),
  baseVerified: z.boolean(),
  provider: z.enum(["shopify-website", "tiktok-shop"]),
  networks: z.enum(["instagram+tiktok", "instagram", "tiktok"]),
  /** Integer minor units. Always zero for new acquisition; the server enforces that, the shape only guards the type. */
  upfrontFeeMinor: minorUnits,
  compensation: z.enum(["percentage", "fixedPerSale"]),
  sampleShippingMinor: minorUnits,
}).strict();

const offerDraft = z.object({
  offerId: text,
  offerCode: text,
  version: text,
  /** Null until the offer service acknowledges a save. */
  savedAt: instant.nullable(),
  recruitmentSource: text,
  payload: offerDraftPayloadSchema,
  assumptions: z.object({ netSaleMinor: minorUnits, commerceCostMinor: minorUnits, processingPctOfCommission: percent, baseOrders: count, downsideOrders: count }),
});

const tierId = z.enum(["tech", "phone", "vacation"]);
/** The reward ladder (Creator Offer Economics v1). A recommendation pending owner approval. A null redemption amount is unknown, never 0. */
const offerRewards = z.object({
  offerId: text,
  version: text,
  ownerApproval: z.literal("pending"),
  scenarios: z.array(z.object({ scenarioId: text, label: text })).min(1),
  scenario: z.object({
    scenarioId: text,
    label: text,
    description: text,
    batches: z.array(z.object({ rowId: text, canonicalId: text, source: z.enum(["shopify", "tiktok-shop", "shopify-mirror"]), orders: count, netMinor: minorUnits, refundedMinor: minorUnits, status: z.enum(["matured", "pending", "excluded"]), exclusionReason: text.optional() })),
    events: z.array(z.object({ eventId: text, tier: tierId, at: instant })),
    selections: z.array(z.object({ tier: tierId, state: z.enum(["selected", "notSelected"]), item: text.nullable(), selectedAt: instant.nullable() })),
    redemptions: z.array(z.object({ tier: tierId, amountMinor: minorUnits.nullable(), at: instant })),
    costEvidence: z.enum(["complete", "incomplete"]),
    newCommitmentsPaused: z.boolean(),
  }),
});

export const scorecardsViewSchemas: Record<string, z.ZodTypeAny> = { assessmentRecord, offerDraft: z.union([offerRecordSchema.extend({ commercialEligibility: commercialEligibilityViewSchema.optional(), saveRecovery: offerSaveRecoverySchema.optional() }), offerDraft]), offerRewards: z.union([rewardsRecordSchema, offerRewards]) };
