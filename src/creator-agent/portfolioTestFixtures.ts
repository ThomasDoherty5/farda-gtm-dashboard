import { PORTFOLIO_VERSION, type PortfolioPacket } from "./portfolio.ts";
export const PORTFOLIO_TEST_SCOPE = { workspaceId: "synthetic-portfolio-workspace", accountId: "synthetic-portfolio-account" };
export const observedPortfolioNumber = (value: number | null) => ({ value, evidenceRefs: value === null ? [] : ["synthetic:source-ledger"] });
export const observedPortfolioFlag = (value: boolean | null) => ({ value, evidenceRefs: value === null ? [] : ["synthetic:review-receipt"] });
export function syntheticPortfolioCreator(id = "synthetic-creator"): PortfolioPacket["creators"][number] {
  return {
    creatorId: id, identityRef: `synthetic:identity:${id}`, ownerRef: "synthetic:review-owner",
    contactEligible: observedPortfolioFlag(true), suppressed: observedPortfolioFlag(false), inactive: observedPortfolioFlag(false),
    outstandingObligationRefs: [], earnedCommissionRefs: ["synthetic:earned-commission"],
    collaborations: [{
      collaborationId: `${id}-collaboration`, campaignId: "synthetic-campaign", briefRevision: "synthetic-brief-v1", deliverableIds: [`${id}-deliverable`],
      posts: [{ postId: `${id}-post`, publishedAt: "2026-10-20T00:00:00Z" }], evidenceRefs: ["synthetic:collaboration"],
      acceptedUsableAssets: observedPortfolioNumber(1), deliveryReliable: observedPortfolioFlag(true), revisionHistoryRefs: ["synthetic:revision"], rightsUsable: observedPortfolioFlag(true),
      organic: { definition: "synthetic-native-views", window: "synthetic-14-day", value: observedPortfolioNumber(0), paidAmplified: false },
      paid: { definition: "synthetic-validated-creative", window: "synthetic-14-day", validatedPerformer: observedPortfolioFlag(false) },
      retainedContribution: { currency: "USD", maturity: "mature", cents: observedPortfolioNumber(0), adjustmentRefs: [] },
    }],
    next: {
      briefRef: "synthetic:next-brief-v1", expectedDeliverables: [{ deliverableId: `${id}-next-deliverable`, format: "synthetic-short-video", quantity: 1 }],
      dueAt: "2026-11-30T00:00:00Z", nextReviewAt: "2026-12-07T00:00:00Z", alreadyHasUsableProduct: observedPortfolioFlag(false),
      sampleUnits: 1, sampleCashCents: 2500, reviewSlots: 1, approvalSlots: 1, providerUsage: [{ quotaId: "synthetic-provider-invitations", unit: "invitations", quantity: 1 }],
    },
  };
}
export function syntheticPortfolioPacket(): PortfolioPacket {
  return {
    schemaVersion: PORTFOLIO_VERSION, evidenceRevision: "synthetic-evidence-v1", policyRef: "synthetic:existing-policy", programId: "synthetic-program", campaignId: "synthetic-campaign", currency: "USD", objective: "usable-content",
    reviewWindow: { start: "2026-10-28T00:00:00Z", end: "2026-11-04T00:00:00Z" },
    trigger: { kind: "weekly-performance-review", eventId: "synthetic-review-event", sourceRef: "synthetic:existing-weekly-review" },
    comparison: { publicationAgeMinDays: 14, publicationAgeMaxDays: 30, organicDefinition: "synthetic-native-views", organicWindow: "synthetic-14-day", paidDefinition: "synthetic-validated-creative", paidWindow: "synthetic-14-day" },
    capacity: {
      maximumCreators: { available: 3, outstanding: 0 }, sampleUnits: { available: 3, outstanding: 0 }, sampleCashCents: { available: 7500, outstanding: 0 }, reviewSlots: { available: 3, outstanding: 0 }, approvalSlots: { available: 3, outstanding: 0 },
      providerQuotas: [{ quotaId: "synthetic-provider-invitations", unit: "invitations", available: 3, outstanding: 0 }], evidenceRefs: ["synthetic:capacity-ledgers"],
    }, creators: [syntheticPortfolioCreator()],
  };
}
