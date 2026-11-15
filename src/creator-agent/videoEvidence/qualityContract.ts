import { z } from "zod";
import { audioCoverageSchema, viewingStatusSchema } from "../evidence.ts";

/**
 * Browser-safe J20 evidence-quality projection. It separates footage observations, modality/range coverage and
 * metadata-only discovery, and it is derived from the stored packet on read; nothing here is stored or writable.
 */
const count = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(240);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
export const j20NextActionSchema = z.enum(["reviewComplete", "needsPlayback", "needsMetricProof", "needsAudienceProof", "needsClaimReview", "sourceUnavailable"]);
const featureState = z.enum(["observed", "notObserved", "unknown"]);

export const videoEvidenceQualitySchema = z.object({
  schemaVersion: z.literal("farda.video-evidence.v1"),
  collectorStage: z.enum(["synthetic-fixture", "source"]),
  collectorVersion: id,
  counts: z.object({ listed: count.nullable(), observed: count, accessible: count, eligible: count, reviewed: count, metadataOnly: count, excluded: count }).strict(),
  footage: z.array(z.object({
    postId: id, access: z.enum(["permitted", "loginRequired", "permissionDenied", "unavailable", "deleted"]),
    change: z.enum(["firstObserved", "unchanged", "changed", "removed", "unverified"]),
    /** Who produced the stored review. A collector review is always the agent; a person reviews only through annotations. */
    reviewer: z.enum(["agent", "person", "unknown"]),
    viewingStatus: viewingStatusSchema, audioCoverage: audioCoverageSchema,
    visualSeconds: z.number().nonnegative(), heardSeconds: z.number().nonnegative(), durationSeconds: z.number().positive().nullable(),
    visualCoveragePct: z.number().min(0).max(100).nullable(), heardCoveragePct: z.number().min(0).max(100).nullable(), sampledPoints: count,
    /** Player time is shown for audit only; it is never coverage. */
    playbackElapsedSeconds: z.number().nonnegative().nullable(),
    features: z.object({ hook: featureState, handlingOperationUse: featureState, explanation: featureState, visibleOutcome: featureState, cta: featureState }).strict(),
    narration: count, outcomeCausality: z.literal("unresolved"),
    /**
     * Claims a person must review (medical, compatibility, outcome, uncategorized or health-worded), with their existing
     * reviewer target (`claim-N`) and the disposition recorded on the disagree/override path. The agent never resolves one.
     */
    claimsReview: z.array(z.object({ targetId: z.string().regex(/^claim-\d+$/), atSec: z.number().nonnegative(), text: z.string().min(1).max(1_000),
      topic: z.enum(["compatibility", "medical", "productFunction", "outcome", "other"]).nullable(), disposition: z.enum(["pending", "disagreed", "overridden"]) }).strict()).max(500),
    quarantinedFields: count,
    nextAction: j20NextActionSchema,
  }).strict()).max(50),
  metadataOnly: z.array(z.object({
    postId: id, publishedAt: z.string().nullable(), ageDays: z.number().nonnegative().nullable(), pinned: z.boolean().nullable(),
    paid: z.enum(["yes", "no", "unknown"]), likeGate: z.enum(["pass", "fail", "unknown"]), rawLikeLabel: z.string().nullable(), reasons: z.array(code).max(8),
  }).strict()).max(200),
  packet: z.object({ qualifyingPosts: count, publicationDates: count, actionPosts: count, status: z.enum(["packetComplete", "needsEvidence"]) }).strict(),
  audience: z.object({ verified: count, unverified: count }).strict(),
  nextAction: j20NextActionSchema,
  limitations: z.array(code).max(30),
}).strict();
export type VideoEvidenceQuality = z.infer<typeof videoEvidenceQualitySchema>;
