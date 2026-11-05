// @vitest-environment node
import { describe, expect, it } from "vitest";
import { portfolioPacketSchema, portfolioReviewKey, reviewPortfolio } from "./portfolio.ts";
import { observedPortfolioFlag as flag, observedPortfolioNumber as number, syntheticPortfolioCreator, syntheticPortfolioPacket } from "./portfolioTestFixtures.ts";

describe("reviewed creator portfolio and bounded cohort proposals", () => {
  it("retains zero-post/zero-sale creators without turning missing evidence into zero or failure", () => {
    const packet = syntheticPortfolioPacket();
    const c = packet.creators[0]!;
    c.collaborations[0]!.posts = [];
    c.collaborations[0]!.retainedContribution.maturity = "immature";
    c.collaborations[0]!.retainedContribution.cents = number(null);
    const review = reviewPortfolio(packet);
    expect(review.recommendations[0]).toMatchObject({ action: "observe", objectiveValue: null, segments: ["new-test", "evidence-immature"] });
    expect(review.cohort.selectedCreatorIds).toEqual([]);
    expect(packet.creators[0]!.collaborations[0]!.organic.value.value).toBe(0);
  });
  it("uses mature retained evidence for sales and leaves immature outcomes under observation", () => {
    const packet = syntheticPortfolioPacket(); packet.objective = "retained-sales";
    packet.creators[0]!.collaborations[0]!.retainedContribution = { currency: "USD", maturity: "immature", cents: number(50000), adjustmentRefs: [] };
    const result = reviewPortfolio(packet).recommendations[0]!;
    expect(result.action).toBe("observe");
    expect(result.objectiveValue).toBeNull();
    expect(result.segments).not.toContain("retained-sales-performer");
  });
  it("keeps strong usable content despite weak sales and uses the stated objective", () => {
    const packet = syntheticPortfolioPacket();
    expect(reviewPortfolio(packet).recommendations[0]).toMatchObject({ action: "renew", objectiveValue: 1 });
    packet.objective = "retained-sales";
    expect(reviewPortfolio(packet).recommendations[0]).toMatchObject({ action: "new-brief", objectiveValue: 0, segments: ["reliable-content-producer"] });
    expect(reviewPortfolio(packet).safeguards).toEqual({ dispatchAuthorized: false, modelPolicyChanged: false, attributionIsIncrementality: false, existingObligationsPreserved: true });
  });
  it("separates paid creative from organic observations and never claims incrementality", () => {
    const packet = syntheticPortfolioPacket(); packet.objective = "paid-creative";
    const collaboration = packet.creators[0]!.collaborations[0]!;
    collaboration.paid.validatedPerformer = flag(true);
    collaboration.organic.paidAmplified = true;
    const result = reviewPortfolio(packet);
    expect(result.recommendations[0]).toMatchObject({ action: "renew", objectiveValue: 1 });
    expect(result.recommendations[0]!.segments).toContain("paid-creative-performer");
    expect(result.recommendations[0]!.uncertainty).toContain("ORGANIC_PAID_CONTEXT_MIXED_OR_UNKNOWN");
    expect(result.safeguards.attributionIsIncrementality).toBe(false);
    collaboration.paid.window = "synthetic-different-window";
    expect(reviewPortfolio(packet).recommendations[0]!.objectiveValue).toBeNull();
  });
  it("does not pool concurrent campaigns, younger posts or mismatched aggregate publication ages", () => {
    const packet = syntheticPortfolioPacket(); packet.objective = "retained-sales";
    const c = packet.creators[0]!;
    const other = structuredClone(c.collaborations[0]!);
    other.collaborationId = "synthetic-other-collaboration"; other.campaignId = "synthetic-other-campaign";
    other.posts[0]!.postId = "synthetic-other-post"; other.retainedContribution.cents = number(999999);
    c.collaborations.push(other);
    expect(reviewPortfolio(packet).recommendations[0]!.objectiveValue).toBe(0);
    expect(reviewPortfolio(packet).recommendations[0]!.comparableCollaborationIds).toEqual(["synthetic-creator-collaboration"]);
    c.collaborations[0]!.posts.push({ postId: "synthetic-younger-post", publishedAt: "2026-11-03T00:00:00Z" });
    expect(reviewPortfolio(packet).recommendations[0]!.objectiveValue).toBeNull();
  });
  it("preserves obligations/earned commissions and blocks new invitations after opt-out", () => {
    const packet = syntheticPortfolioPacket();
    packet.creators[0]!.suppressed = flag(true);
    packet.creators[0]!.outstandingObligationRefs = ["synthetic:owed-review"];
    const review = reviewPortfolio(packet);
    expect(review.recommendations[0]).toMatchObject({ action: "stop-new-invitations", outstandingObligationRefs: ["synthetic:owed-review"], earnedCommissionRefs: ["synthetic:earned-commission"] });
    expect(review.cohort.selectedCreatorIds).toHaveLength(0);
  });
  it("limits proposals by outstanding stock, cash, review/approval work and exact provider units", () => {
    const packet = syntheticPortfolioPacket();
    packet.creators.push(syntheticPortfolioCreator("synthetic-creator-b"), syntheticPortfolioCreator("synthetic-creator-c"));
    packet.capacity.sampleUnits = { available: 2, outstanding: 1 };
    const result = reviewPortfolio(packet);
    expect(result.cohort.selectedCreatorIds).toEqual(["synthetic-creator"]);
    expect(result.cohort.forecast).toMatchObject({ creators: 1, sampleUnits: 1, sampleCashCents: 2500, reviewSlots: 1, approvalSlots: 1 });
    expect(result.cohort.held[0]!.reasons).toContain("CAPACITY_EXCEEDED:sampleUnits");
    packet.capacity.sampleUnits = { available: 3, outstanding: 0 };
    packet.capacity.providerQuotas[0]!.unit = "messages";
    expect(reviewPortfolio(packet).cohort.selectedCreatorIds).toEqual([]);
    packet.capacity.providerQuotas[0]!.unit = "invitations";
    packet.capacity.providerQuotas[0]!.available = 0;
    expect(reviewPortfolio(packet).cohort.held[0]!.reasons).toContain("QUOTA_EXCEEDED:synthetic-provider-invitations");
  });
  it("reuses evidenced existing product without a sample or unknown stock budget blocking zero consumption", () => {
    const packet = syntheticPortfolioPacket();
    packet.creators[0]!.next.alreadyHasUsableProduct = flag(true);
    packet.capacity.sampleUnits = { available: null, outstanding: null };
    packet.capacity.sampleCashCents = { available: null, outstanding: null };
    const result = reviewPortfolio(packet);
    expect(result.cohort.selectedCreatorIds).toEqual(["synthetic-creator"]);
    expect(result.cohort.forecast.sampleUnits).toBe(0);
    expect(result.cohort.forecast.sampleCashCents).toBe(0);
    expect(result.cohort.candidates[0]!.requiresNewSample).toBe(false);
    packet.creators[0]!.next.alreadyHasUsableProduct = flag(null);
    expect(reviewPortfolio(packet).cohort.held[0]!.reasons).toContain("PRODUCT_POSSESSION_UNKNOWN");
  });
  it("does not promote an unknown contact or capacity state and does not treat a maximum as a target", () => {
    const packet = syntheticPortfolioPacket();
    expect(reviewPortfolio(packet).cohort.forecast.creators).toBe(1);
    packet.creators[0]!.contactEligible = flag(null);
    expect(reviewPortfolio(packet).recommendations[0]!.action).toBe("observe");
    packet.creators[0]!.contactEligible = flag(true);
    packet.capacity.reviewSlots.available = null;
    expect(reviewPortfolio(packet).cohort.held[0]!.reasons).toContain("CAPACITY_UNKNOWN:reviewSlots");
  });
  it("rejects forged fields, unsupported known facts, duplicate publications, and reversed windows", () => {
    const packet = syntheticPortfolioPacket();
    expect(portfolioPacketSchema.safeParse({ ...packet, approved: true }).success).toBe(false);
    packet.creators[0]!.contactEligible = { value: true, evidenceRefs: [] };
    expect(portfolioPacketSchema.safeParse(packet).success).toBe(false);
    packet.creators[0]!.contactEligible = flag(true);
    packet.creators[0]!.collaborations[0]!.posts.push({ ...packet.creators[0]!.collaborations[0]!.posts[0]! });
    expect(portfolioPacketSchema.safeParse(packet).success).toBe(false);
  });
  it("uses stable program/window and creator keys across evidence revisions without mixing programs", () => {
    const packet = syntheticPortfolioPacket();
    const first = reviewPortfolio(packet);
    packet.evidenceRevision = "synthetic-v2";
    expect(portfolioReviewKey(packet)).toBe(first.reviewKey);
    expect(reviewPortfolio(packet).recommendations[0]!.key).toBe(first.recommendations[0]!.key);
    packet.programId = "synthetic-other-program";
    expect(portfolioReviewKey(packet)).not.toBe(first.reviewKey);
  });
  it("rejects two creator IDs for one canonical identity without merging their obligations or allocating twice", () => {
    const packet = syntheticPortfolioPacket();
    const alias = syntheticPortfolioCreator("synthetic-creator-alias");
    alias.identityRef = packet.creators[0]!.identityRef;
    alias.outstandingObligationRefs = ["synthetic:alias-obligation"];
    packet.creators.push(alias);
    expect(() => reviewPortfolio(packet)).toThrow("Duplicate canonical creator identity");
    // A distinct evidenced identity remains distinct; the runtime does not infer or merge actors.
    alias.identityRef = "synthetic:distinct-canonical-identity";
    expect(reviewPortfolio(packet).cohort.selectedCreatorIds).toEqual(["synthetic-creator", "synthetic-creator-alias"]);
  });
  it("requires a positive known new sample allocation while preserving unknown and evidenced zero-consumption cases", () => {
    const packet = syntheticPortfolioPacket();
    const next = packet.creators[0]!.next;
    next.sampleUnits = 0;
    expect(() => reviewPortfolio(packet)).toThrow("A known new sample allocation must contain at least one unit");
    next.sampleUnits = null;
    expect(reviewPortfolio(packet).cohort.held[0]!.reasons).toContain("CAPACITY_UNKNOWN:sampleUnits");
    next.sampleUnits = 1;
    expect(reviewPortfolio(packet).cohort.forecast.sampleUnits).toBe(1);
    next.alreadyHasUsableProduct = flag(true);
    next.sampleUnits = 0;
    const existing = reviewPortfolio(packet);
    expect(existing.cohort.candidates[0]!.requiresNewSample).toBe(false);
    expect(existing.cohort.forecast.sampleUnits).toBe(0);
    next.alreadyHasUsableProduct = flag(null);
    expect(() => reviewPortfolio(packet)).toThrow("A known new sample allocation must contain at least one unit");
  });
});
