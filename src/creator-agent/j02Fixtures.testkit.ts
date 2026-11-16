/** Frozen J02-09 inputs. Synthetic only; the numeric configuration is the owner-approved bound website baseline. */
import { readFileSync } from "node:fs";
import { assessCreator } from "./policy.ts";
import { loadApprovedBindings } from "./config.ts";
import { evidencePacketSchema, type EvidencePacket } from "./evidence.ts";
import { resolveScorecardEvidence, type ScorecardSourceSnapshot } from "./routeEvidence.ts";
import type { OfferRepository } from "./offers/repository.ts";
import type { CreatorAssessment } from "./assessmentSchema.ts";
import { SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { fixtureJ20Post, fixtureMetric, fixtureReviews } from "./videoEvidence/fixtures.testkit.ts";

export type FrozenFixtures = {
  modelId: "WEBSITE-AFFILIATE-v3"; configHash: string; nowMs: number;
  base: { packet: EvidencePacket; source: ScorecardSourceSnapshot };
  expected: CreatorAssessment;
  cases: Record<FrozenCase, { change: string; delta: Partial<CreatorAssessment> }>;
};
/**
 * `expiredSourceProof` expires the whole provider envelope that carries audience, commerce and terms proof. No approved
 * maximum age exists for the audience window itself, so a stale audience window inside a current envelope is not tested
 * here as stale; see the pinned NEEDS-OWNER case in `j02Fixtures.test.ts`.
 */
export const frozenCases = ["viralOutlier", "missingShares", "mixedPaidTraffic", "expiredSourceProof", "incompleteFootage", "changedOffer", "replay"] as const;
export type FrozenCase = typeof frozenCases[number];
export const frozenPath = new URL("./scoringFixtures/j02-frozen.json", import.meta.url);
export const readFrozen = () => JSON.parse(readFileSync(frozenPath, "utf8")) as FrozenFixtures;

type Input = { packet: EvidencePacket; source: ScorecardSourceSnapshot; accepted?: ReturnType<OfferRepository["acceptedTerms"]> };
/** Each case is the frozen base plus one named change. */
export function frozenInput(base: FrozenFixtures["base"], name: FrozenCase): Input {
  const packet = structuredClone(base.packet), source = structuredClone(base.source);
  switch (name) {
    case "viralOutlier": packet.recentPosts[0]!.views = { status: "known", value: 5_000_000, definition: "synthetic native video views", window: "lifetime at synthetic snapshot" }; break;
    case "missingShares":
      // J20-collected reviewed posts with exact views, comment totals and saves, but shares hidden by the source.
      packet.posts = [1, 2, 3].map(n => fixtureJ20Post(n, fixtureReviews.complete, { metrics: (["views", "comments", "shares", "saves"] as const)
        .map(key => fixtureMetric(key, key === "shares" ? null : key === "views" ? 1000 + n : 10 + n)) }));
      break;
    case "mixedPaidTraffic":
      for (const row of packet.recentPosts.slice(0, 3)) row.paid = "yes";
      source.metrics = source.metrics.map(m => ({ ...m, trafficMix: "mixed", refundBasis: "excluded" }));
      break;
    case "expiredSourceProof": source.validUntil = "2026-01-01T00:00:00.000Z"; break;
    case "incompleteFootage": packet.posts[2]!.review = { ...packet.posts[2]!.review, status: "partial" }; break;
    case "changedOffer": {
      const t = source.terms!;
      Object.assign(t, { origin: "saved-offer", provider: "shopify-collabs", eligibleBase: "retained-eligible-merchandise" });
      source.provider = "shopify-collabs";
      packet.termsRevision = source.termsRevision = t.termsRevision = t.manifestHash;
      const commission = { type: "percentage" as const, standardRateBps: 2000, fixedMinor: null, shopAdsRateBps: null, currency: "USD" as const, base: "retained-eligible-merchandise" as const, effectiveAt: null };
      // The creator accepted v1; the saved offer has since moved to v2, so the accepted terms no longer match the current offer.
      return { packet: evidencePacketSchema.parse(packet), source, accepted: { offerId: t.offerId, version: "v2", manifestHash: t.manifestHash, creatorId: packet.creatorId,
        route: packet.checkoutRoute, currency: "USD", commission, acceptedRef: t.acceptedRef, validUntil: "2030-01-01T00:00:00Z",
        provider: { sourceRef: "synthetic:provider", observedAt: source.observedAt, validUntil: "2030-01-01T00:00:00Z", provider: "shopify-collabs", programRef: source.programId,
          supportsPercentage: true, supportsFixedPerSale: false, actualCommission: commission, payoutOwner: "provider", attributionWindowDays: 30, precedence: "verified",
          conflictRule: "verified", holdDays: 30, payoutSchedule: "monthly", payoutThresholdMinor: 0, onboarding: "verified", feeTreatment: "verified",
          fundingRule: "verified", refundRule: t.refundRule, trackingOwner: "provider" } } as ReturnType<OfferRepository["acceptedTerms"]> };
    }
    case "replay": break;
  }
  return { packet: evidencePacketSchema.parse(packet), source };
}

export async function runFrozen(base: FrozenFixtures["base"], name: FrozenCase, nowMs: number) {
  const binding = loadApprovedBindings().find(b => b.current.modelId === "WEBSITE-AFFILIATE-v3")!;
  const { packet, source, accepted } = frozenInput(base, name);
  const proof = await resolveScorecardEvidence({ resolve: () => structuredClone(source) }, { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]! },
    packet, nowMs, accepted === undefined ? undefined : () => accepted);
  // Each frozen case is a first assessment of its creator.
  return assessCreator(packet, binding, proof, { rescore: { triggers: ["initial"], priorRevision: null } });
}
