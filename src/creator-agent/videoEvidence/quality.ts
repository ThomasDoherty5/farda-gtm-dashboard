import { claimKey, personClaims, reviewCoverage, type ClaimRecord, type EvidencePacket, type PostEvidence } from "../evidence.ts";
import type { CreatorAssessment } from "../assessmentSchema.ts";
import { likeGate } from "../policy.ts";
import { videoEvidenceQualitySchema, type VideoEvidenceQuality } from "./qualityContract.ts";

type NextAction = VideoEvidenceQuality["nextAction"];
const FEATURES = ["hook", "handlingOperationUse", "explanation", "visibleOutcome", "cta"] as const;
const DAY_MS = 86_400_000;

/** Disposition kind recorded on the existing reviewer path, by post and target. */
export type ClaimDispositions = ReadonlyMap<string, ReadonlyMap<string, "disagree" | "override">>;

function footage(post: PostEvidence, quarantined: number, claims: readonly ClaimRecord[], stored: ReadonlyMap<string, "disagree" | "override">,
  live: ReadonlyMap<string, "disagree" | "override">): VideoEvidenceQuality["footage"][number] {
  const coverage = reviewCoverage(post.review);
  const access = post.accessObservation?.state ?? "permitted";
  // A clip watched in full or credited as a complete sampled review can say a feature was not shown; anything less stays unknown.
  const fullyReviewed = post.review.status === "complete";
  const shown = new Set(post.review.observedActions.flatMap(action => action.kind ? [action.kind] : []));
  const features = Object.fromEntries(FEATURES.map(key => [key, shown.has(key) ? "observed" : fullyReviewed ? "notObserved" : "unknown"])) as
    VideoEvidenceQuality["footage"][number]["features"];
  // Carried claims stay listed after a later read drops them; a current target appears only while the current review shows the claim.
  const claimsReview = claims.map(entry => {
    const index = post.review.claims.findIndex(claim => claimKey(post.postId, claim) === claimKey(entry.postId, entry.claim));
    const targetId = index < 0 ? null : `claim-${index}`;
    const kind = stored.get(claimKey(entry.postId, entry.claim)) ?? (targetId ? live.get(targetId) : undefined);
    return { targetId, atSec: entry.claim.atSec, text: entry.claim.text, topic: entry.claim.topic,
      disposition: kind === "disagree" ? "disagreed" as const : kind === "override" ? "overridden" as const : "pending" as const };
  });
  const nextAction: NextAction = access !== "permitted" ? "sourceUnavailable" : !fullyReviewed ? "needsPlayback"
    : claimsReview.some(claim => claim.disposition === "pending") || quarantined ? "needsClaimReview" : "reviewComplete";
  const reviewerRef = post.review.reviewerRef ?? null;
  return { postId: post.postId, access, change: post.source?.change ?? "firstObserved",
    reviewer: reviewerRef === null ? "unknown" : reviewerRef.startsWith("agent:") ? "agent" : post.source ? "unknown" : "person", viewingStatus: coverage.viewingStatus, audioCoverage: coverage.audioCoverage,
    visualSeconds: coverage.visualSeconds, heardSeconds: coverage.heardSeconds, durationSeconds: coverage.durationSeconds,
    visualCoveragePct: coverage.visualCoveragePct, heardCoveragePct: coverage.heardCoveragePct, sampledPoints: coverage.sampledPoints,
    playbackElapsedSeconds: coverage.playbackElapsedSeconds, features, narration: post.review.narration?.length ?? 0, outcomeCausality: "unresolved",
    claimsReview, quarantinedFields: quarantined, nextAction };
}

/**
 * The J20 evidence-quality report for one stored, collected packet. Footage observations, modality/range coverage and
 * metadata-only discovery stay separate; counts come from stored facts and the stored J02 packet decision, never from a
 * collector's own claim. Returns null for packets that were not collected by J20.
 */
export function videoEvidenceQuality(record: { packet: EvidencePacket; assessment: Pick<CreatorAssessment, "packet" | "gates"> },
  dispositions: ClaimDispositions = new Map()): VideoEvidenceQuality | null {
  const { packet, assessment } = record;
  const collection = packet.collection;
  if (!collection) return null;
  const quarantinedBy = (postId: string) => collection.quarantined.filter(entry => entry.postId === postId).length;
  const ledger = personClaims(packet).all;
  const stored = new Map((collection.claimDispositions ?? []).map(entry => [claimKey(entry.postId, entry.claim), entry.kind] as const));
  const posts = packet.posts.map(post => footage(post, quarantinedBy(post.postId), ledger.filter(entry => entry.postId === post.postId), stored,
    dispositions.get(post.postId) ?? new Map()));
  const reviewed = new Set(packet.posts.map(post => post.postId));
  const exclusions = new Map(collection.exclusions.map(entry => [entry.postId, entry.reasons]));
  const observedAt = Date.parse(collection.observedAt);
  const metadataOnly = packet.recentPosts.filter(post => !reviewed.has(post.postId)).map(post => ({
    postId: post.postId, publishedAt: post.publishedAt,
    ageDays: post.publishedAt ? Math.max(0, Math.floor((observedAt - Date.parse(post.publishedAt)) / DAY_MS)) : null,
    pinned: post.pinned, paid: post.paid, likeGate: likeGate({ nativeLikes: post.nativeLikes } as PostEvidence),
    rawLikeLabel: post.nativeLikes.rawLabel ?? null, reasons: exclusions.get(post.postId) ?? [],
  }));
  const ids = new Set([...packet.posts, ...packet.recentPosts].map(post => post.postId).concat([...exclusions.keys()]));
  const accessExcluded = collection.exclusions.filter(entry => entry.reasons.some(reason => reason.startsWith("ACCESS_") || reason === "POST_REMOVED")).length;
  const accessible = ids.size - accessExcluded - packet.posts.filter(post => (post.accessObservation?.state ?? "permitted") !== "permitted").length;
  const eligible = packet.posts.filter(post => post.relevant && likeGate(post) === "pass" && (post.accessObservation?.state ?? "permitted") === "permitted");
  const complete = eligible.filter(post => post.review.status === "complete");
  const packetComplete = ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE"].every(gateId => assessment.gates.find(gate => gate.id === gateId)?.state === "pass");
  const verifiedAudience = collection.audience.filter(entry => entry.verified).length;
  const limitations = new Set<string>();
  if (collection.collectorStage === "synthetic-fixture") limitations.add("SYNTHETIC_FIXTURE_COLLECTOR");
  if (collection.listedPosts === null || collection.listedPosts > ids.size) limitations.add("PARTIAL_SOURCE_LISTING");
  if (posts.some(post => post.viewingStatus === "sampledFrames")) limitations.add("SAMPLED_FRAMES_NOT_CONTINUOUS");
  if (posts.some(post => post.audioCoverage !== "heard")) limitations.add("AUDIO_NOT_HEARD_ON_SOME_POSTS");
  if (collection.quarantined.length) limitations.add("INFERENCE_TEXT_QUARANTINED");
  if (!verifiedAudience) limitations.add("NO_VERIFIED_AUDIENCE_REPORT");
  // Descriptive, not a gate: J02 keeps main's completion rule; whether full coverage is required is an owner decision.
  if (packet.posts.some(post => post.review.status === "complete" && post.review.visualMethod === "continuous" &&
      !["completeAudioVisual", "fullVisualOnly"].includes(reviewCoverage(post.review).viewingStatus))) limitations.add("COMPLETE_REVIEW_WITHOUT_FULL_COVERAGE");
  const pendingLikes = metadataOnly.some(post => post.reasons.includes("LIKES_PENDING_PROOF"));
  // Carried claims on posts no longer in the packet still need a person until disposed of.
  const shownPosts = new Set(packet.posts.map(post => post.postId));
  const orphanClaims = personClaims(packet).pending.filter(entry => !shownPosts.has(entry.postId)).length;
  if (orphanClaims) limitations.add("CARRIED_CLAIMS_PENDING");
  const nextAction: NextAction = orphanClaims || posts.some(post => post.nextAction === "needsClaimReview") ? "needsClaimReview"
    : !eligible.length && (posts.length || accessExcluded) && posts.every(post => post.nextAction === "sourceUnavailable") ? "sourceUnavailable"
      : !packetComplete && posts.some(post => post.nextAction === "needsPlayback") ? "needsPlayback"
        : !packetComplete && pendingLikes ? "needsMetricProof"
          : !packetComplete ? "needsPlayback"
            : !verifiedAudience ? "needsAudienceProof" : "reviewComplete";
  return videoEvidenceQualitySchema.parse({
    schemaVersion: collection.schemaVersion, collectorStage: collection.collectorStage, collectorVersion: collection.collectorVersion,
    counts: { listed: collection.listedPosts, observed: ids.size, accessible, eligible: eligible.length, reviewed: complete.length,
      metadataOnly: metadataOnly.length, excluded: collection.exclusions.length },
    footage: posts, metadataOnly,
    packet: { qualifyingPosts: assessment.packet.qualifyingPosts, publicationDates: assessment.packet.publicationDates,
      actionPosts: assessment.packet.meaningfulUsePosts, status: packetComplete ? "packetComplete" : "needsEvidence" },
    audience: { verified: verifiedAudience, unverified: collection.audience.length - verifiedAudience },
    nextAction, limitations: [...limitations].sort(),
  });
}
