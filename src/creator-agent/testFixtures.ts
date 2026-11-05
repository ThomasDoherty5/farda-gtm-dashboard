/** Synthetic test inputs only. No real creator, private policy text or production numeric configuration is shipped. */
import { bindConfig, digest, modelConfigSchema, type ConfigBinding, type ModelConfig } from "./config.ts";
import { evidencePacketSchema, type EvidencePacket, type PostEvidence, type RecentPostMetadata } from "./evidence.ts";

export const SYNTHETIC_READ_TOKEN = "synthetic-reader-token-not-a-secret-0001";
export const SYNTHETIC_REVIEW_TOKEN = "synthetic-review-token-not-a-secret-0002";
export const SYNTHETIC_SCOPE = { workspaceId: "synthetic-workspace", accountIds: ["synthetic-account"], environment: "sandbox" as const };

export function syntheticConfig(route: EvidencePacket["checkoutRoute"] = "website"): ModelConfig {
  return modelConfigSchema.parse({
    modelId: route === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3",
    version: "synthetic-config-v1", approvalRef: "synthetic:approval-not-production", baselineUri: "synthetic:baseline-not-production",
    criteria: [{ id: "synthetic-routine", label: "Synthetic routine criterion", weight: 43 }, { id: "synthetic-demo", label: "Synthetic demonstration criterion", weight: 57 }],
    routineCriterionId: "synthetic-routine", demoCriterionId: "synthetic-demo",
    arithmetic: "weight*rating/5;round-complete-total;no-rescaling",
    bands: [{ id: "synthetic-review", min: 0 }, { id: "synthetic-priority", min: 77 }],
    decisionRules: { invitationMinScore: null, activationMinScore: 50, minCoveragePct: 0 },
  });
}

export function syntheticBinding(route: EvidencePacket["checkoutRoute"] = "website"): ConfigBinding {
  const baseline = syntheticConfig(route);
  return bindConfig(structuredClone(baseline), baseline, digest(baseline));
}

export function syntheticPost(n: number): PostEvidence {
  return {
    postId: `synthetic-post-${n}`, canonicalMediaId: `synthetic-media-${n}`, network: "instagram",
    sourceUrl: `https://www.instagram.com/reel/SYNTHETIC_${n}/`,
    publishedAt: `2026-10-${String(n === 1 ? 1 : 2).padStart(2, "0")}T12:00:00.000Z`,
    observedAt: "2026-11-04T12:00:00.000Z", relevant: true,
    nativeLikes: { status: "known", value: 201, exact: true, sourceRef: `synthetic:metric:${n}` },
    review: {
      status: "complete", visualMethod: n === 1 ? "continuous" : "sampledFrames", audioMethod: "unassessed",
      sampledPoints: n === 1 ? [] : [0, 4, 8], watchedIntervals: n === 1 ? [{ startSec: 0, endSec: 8 }] : [],
      observedActions: n <= 2 ? [{ atSec: 4, action: "Opens a fictional case and returns it to a travel bag.", meaningfulUse: true }] : [],
      claims: [], inferences: [], sourceRef: `synthetic:review:${n}`,
    },
    comments: n === 2 ? { status: "unavailable", reason: "Synthetic source-access limitation." } : {
      status: "observed", ordering: "First visible top-level rows in source order", observedAt: "2026-11-04T12:00:00.000Z", rows: n === 3 ? [] : [
        { commentId: "synthetic-comment-1", authorRef: "synthetic-author-1", creator: false, promotional: false, prompted: false, categories: ["purchaseEvaluation", "productUnderstanding"], text: "Would this fictional case fit a small bag?" },
        { commentId: "synthetic-comment-2", authorRef: "synthetic-author-2", creator: false, promotional: false, prompted: true, categories: ["promptedKeyword"], text: "FICTIONAL LINK" },
      ],
    },
  };
}

export function syntheticMetadata(n: number): RecentPostMetadata {
  return {
    postId: `synthetic-recent-${n}`, canonicalMediaId: `synthetic-recent-media-${n}`,
    publishedAt: `2026-10-${String(n).padStart(2, "0")}T12:00:00.000Z`, relevant: true, pinned: false,
    nativeLikes: { status: "known", value: n % 2 ? 5 : 301, exact: true, sourceRef: `synthetic:recent-likes:${n}` },
    views: { status: "known", value: (n - 1) * 100, definition: "synthetic native video views", window: "lifetime at synthetic snapshot" }, paid: "no",
  };
}

export function syntheticPacket(route: EvidencePacket["checkoutRoute"] = "website"): EvidencePacket {
  return evidencePacketSchema.parse({
    creatorId: "synthetic-creator", briefId: "synthetic-travel-use", checkoutRoute: route,
    evidenceRevision: "synthetic-evidence-v1", termsRevision: "synthetic-terms-v1",
    posts: [1, 2, 3].map(syntheticPost), recentPosts: Array.from({ length: 10 }, (_, index) => syntheticMetadata(index + 1)),
    ratings: { routine: 3, demo: 3 }, criterionRatings: {},
    invitationGates: ["identity", "sourcePermission", "suppression", "supportedBrief"].map((id) => ({ id, status: "pass", sourceRef: `synthetic:invite:${id}` })),
    activationGates: [],
  });
}

export function withActivationEvidence(packet: EvidencePacket): EvidencePacket {
  return evidencePacketSchema.parse({ ...packet, activationGates: [
    "audience", "terms", "programEligibility", "attribution", "supportedClaims",
    packet.checkoutRoute === "website" ? "websiteProgramEligibility" : "nativeShopEligibility",
  ].map((id) => ({ id, status: "pass", sourceRef: `synthetic:activate:${id}` })) });
}
