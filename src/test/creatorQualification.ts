/** Synthetic server-wire examples only. No real creator, source review or order data. */
import type { CreatorAssessment } from "@/creator-agent/assessmentSchema";
import type { EvidencePacket } from "@/creator-agent/evidence";

export function syntheticAgentEvidence(over: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    creatorId: "demo-creator-1", briefId: "synthetic-routine", checkoutRoute: "website",
    evidenceRevision: "synthetic-evidence-1", termsRevision: "synthetic-terms-1",
    posts: [{
      postId: "synthetic-post-1", canonicalMediaId: "synthetic-media-1", network: "instagram",
      sourceUrl: "https://www.instagram.com/reel/SYNTHETICPOST1/", publishedAt: "2026-11-01T12:00:00.000Z", observedAt: "2026-11-04T12:00:00.000Z", relevant: true,
      nativeLikes: { status: "known", value: 201, exact: true, sourceRef: "synthetic-metric-receipt" },
      review: { status: "complete", visualMethod: "sampledFrames", audioMethod: "silent", sampledPoints: [0, 5, 12], watchedIntervals: [], observedActions: [{ atSec: 5, action: "Opens and retrieves a container.", meaningfulUse: true }], claims: [], inferences: ["The intended carry setting is not established."], sourceRef: "synthetic-review-receipt" },
      comments: { status: "observed", ordering: "Visible top-level source order", observedAt: "2026-11-04T12:00:00.000Z", rows: [
        { commentId: "synthetic-comment-1", authorRef: "synthetic-author-1", creator: false, promotional: false, prompted: false, categories: ["productUnderstanding"], text: "How does the container open?" },
        { commentId: "synthetic-comment-2", authorRef: null, creator: false, promotional: false, prompted: true, categories: ["promptedKeyword"], text: "LINK" },
      ] },
    }],
    recentPosts: Array.from({ length: 10 }, (_, i) => ({
      postId: `synthetic-recent-${i + 1}`, canonicalMediaId: `synthetic-recent-media-${i + 1}`,
      publishedAt: new Date(Date.UTC(2026, 10, 3 - i, 12)).toISOString(), relevant: true, pinned: false,
      nativeLikes: { status: "known" as const, value: i === 0 ? 40 : 240 + i, exact: true, sourceRef: `synthetic-likes-${i}` },
      views: { status: "known" as const, value: 1_000 + i * 100, definition: "Native views", window: "At observation" }, paid: "unknown" as const,
    })),
    ratings: { routine: 3, demo: 4 }, criterionRatings: {}, criterionEvidenceRefs: {}, invitationGates: [], activationGates: [], ...over,
  };
}

export function syntheticQualification(over: Partial<CreatorAssessment> = {}): CreatorAssessment {
  return {
    schemaVersion: "creator-agent.v1", policyVersion: "2026-11-04", agentVersion: "1.0.0",
    creatorId: "demo-creator-1", briefId: "synthetic-routine", evidenceRevision: "synthetic-evidence-1", termsRevision: "synthetic-terms-1",
    modelId: "WEBSITE-AFFILIATE-v3", config: { status: "unbound", version: null, hash: null, baselineHash: null, numericHash: null },
    state: "reviewNeeded", contentQualification: "reviewNeeded",
    gates: [{ id: "creatorPacket", state: "unknown", reason: "Two additional qualifying source reviews are needed." }],
    packet: { qualifyingPosts: 1, publicationDates: 1, meaningfulUsePosts: 1, postIds: ["synthetic-post-1"] }, criteria: { routine: 3, demo: 4 }, score: null,
    metadata: { sampleSize: 10, coverage: "complete", reasonCodes: [], postIds: Array.from({ length: 10 }, (_, i) => `synthetic-recent-${i + 1}`), medianViews: 1_450, minViews: 1_000, maxViews: 1_900, comparableViewCount: 10 },
    comments: [{ postId: "synthetic-post-1", status: "observed", rowCount: 2, uniqueAuthors: null, unknownAuthorRows: 1, promptedRows: 1, creatorRows: 0, promotionalRows: 0, categoryCounts: { productUnderstanding: 1, promptedKeyword: 1 }, ordering: "Visible top-level source order", reason: null }],
    reviews: [{ postId: "synthetic-post-1", status: "complete", visualMethod: "sampledFrames", audioMethod: "silent", sampledPointCount: 3, continuousSeconds: 0, likeGate: "pass" }], reasonCodes: ["PACKET_INCOMPLETE"], ...over,
  };
}
