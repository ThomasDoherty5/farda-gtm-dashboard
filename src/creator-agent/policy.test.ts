// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bindConfig, digest, modelConfigSchema, numericDigest } from "./config.ts";
import { assessCreator, likeGate } from "./policy.ts";
import { evidencePacketSchema } from "./evidence.ts";
import { AGENT_VERSION, POLICY_VERSION } from "./assessmentSchema.ts";
import { syntheticBinding, syntheticConfig, syntheticPacket, withActivationEvidence } from "./testFixtures.ts";

describe("approved qualification over a bound synthetic baseline", () => {
  it.each([199, 200, 201])("applies the strict source-native %i boundary without a replacement threshold", (value) => {
    const packet = syntheticPacket();
    packet.posts[0]!.nativeLikes = { status: "known", value, exact: true, sourceRef: "synthetic:metric" };
    expect(likeGate(packet.posts[0]!)).toBe(value > 200 ? "pass" : "fail");
    const result = assessCreator(packet, syntheticBinding());
    expect(result.packet.qualifyingPosts).toBe(value > 200 ? 3 : 2);
    expect(result.state).toBe(value > 200 ? "prospectiveInviteEligible" : "reviewNeeded");
  });

  it("keeps unavailable or rounded-unverifiable native likes pending", () => {
    const packet = syntheticPacket();
    for (const likes of [
      { status: "unknown" as const, reason: "Synthetic hidden count." },
      { status: "unavailable" as const, reason: "Synthetic source outage." },
      { status: "known" as const, value: 500, exact: false, sourceRef: "synthetic:ambiguous-rounding" },
    ]) {
      packet.posts[0]!.nativeLikes = likes;
      expect(likeGate(packet.posts[0]!)).toBe("unknown");
      expect(assessCreator(packet, syntheticBinding()).state).toBe("reviewNeeded");
    }
  });

  it("requires three independent complete posts on two dates with two meaningful use examples", () => {
    const cases = [
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts.pop(); },
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts.forEach((post) => { post.publishedAt = "2026-10-01T12:00:00.000Z"; }); },
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts[1]!.review.observedActions = []; },
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts[2]!.canonicalMediaId = packet.posts[0]!.canonicalMediaId; },
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts[2]!.review.status = "partial"; },
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts[2]!.publishedAt = null; },
      (packet: ReturnType<typeof syntheticPacket>) => { packet.posts[2]!.relevant = false; },
    ];
    for (const change of cases) {
      const packet = syntheticPacket();
      change(packet);
      expect(assessCreator(evidencePacketSchema.parse(packet), syntheticBinding()).state).toBe("reviewNeeded");
    }
    expect(assessCreator(syntheticPacket(), syntheticBinding()).packet).toMatchObject({ qualifyingPosts: 3, publicationDates: 2, meaningfulUsePosts: 2 });
  });

  it("uses UTC-normalized publication dates rather than counting timezone spellings as two days", () => {
    const packet = syntheticPacket();
    packet.posts[0]!.publishedAt = "2026-10-01T23:30:00.000Z";
    packet.posts[1]!.publishedAt = "2026-10-02T00:30:00.000+01:00";
    packet.posts[2]!.publishedAt = "2026-10-01T20:30:00.000-03:00";
    expect(assessCreator(packet, syntheticBinding()).packet.publicationDates).toBe(1);
    expect(assessCreator(packet, syntheticBinding()).state).toBe("reviewNeeded");
  });

  it("does not select a weaker canonical duplicate when another eligible copy supplies the observed use", () => {
    const packet = syntheticPacket();
    const earlierWeakCopy = { ...structuredClone(packet.posts[0]!), postId: "synthetic-reupload", sourceUrl: "https://www.instagram.com/reel/SYNTHETIC_REUPLOAD/", publishedAt: "2026-09-01T00:00:00.000Z", review: { ...structuredClone(packet.posts[0]!.review), observedActions: [] } };
    const result = assessCreator(evidencePacketSchema.parse({ ...packet, posts: [earlierWeakCopy, ...packet.posts] }), syntheticBinding());
    expect(result.packet.qualifyingPosts).toBe(3);
    expect(result.packet.meaningfulUsePosts).toBe(2);
  });

  it("keeps unknown critical ratings unknown and enforces both verified 3/5 floors", () => {
    for (const key of ["routine", "demo"] as const) {
      const packet = syntheticPacket();
      packet.ratings[key] = null;
      expect(assessCreator(packet, syntheticBinding()).state).toBe("reviewNeeded");
      packet.ratings[key] = 2;
      expect(assessCreator(packet, syntheticBinding()).state).toBe("hold");
      packet.ratings[key] = 3;
      expect(assessCreator(packet, syntheticBinding()).state).toBe("prospectiveInviteEligible");
    }
  });

  it("cannot compensate for a critical failure with a high weighted total", () => {
    const config = syntheticConfig();
    config.criteria[0]!.weight = 1;
    config.criteria[1]!.weight = 99;
    const binding = bindConfig(config, config, digest(config));
    const packet = syntheticPacket();
    packet.ratings = { routine: 2, demo: 5 };
    const result = assessCreator(packet, binding);
    expect(result.score?.total).toBe(99);
    expect(result.state).toBe("hold");
  });

  it("allows accurate no-CTA content sourcing but does not manufacture commerce activation", () => {
    const packet = syntheticPacket();
    const result = assessCreator(packet, syntheticBinding());
    expect(result.state).toBe("prospectiveInviteEligible");
    expect(result.contentQualification).toBe("pass");
    expect(result.reasonCodes).toContain("ACTIVATE:attribution");
    expect(result.comments.map((sample) => sample.status)).toEqual(["observed", "unavailable", "observed"]);
    expect(result.comments[1]!.rowCount).toBeNull();
    expect(result.comments[2]!.rowCount).toBe(0);
    expect(result.reviews[1]).toMatchObject({ visualMethod: "sampledFrames", continuousSeconds: 0 });
    expect(result.reviews[0]).toMatchObject({ visualMethod: "continuous", continuousSeconds: 8 });
  });

  it.each(["website", "tiktok-shop"] as const)("uses %s route-specific activation evidence independently of publishing network", (route) => {
    const packet = withActivationEvidence(syntheticPacket(route));
    const result = assessCreator(packet, syntheticBinding(route));
    expect(result.state).toBe("activationReady");
    expect(result.modelId).toBe(route === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3");
    expect(() => assessCreator(packet, syntheticBinding(route === "website" ? "tiktok-shop" : "website"))).toThrow("WRONG_ROUTE_MODEL");
  });

  it("cannot use missing or unsourced invitation evidence as a phase-gate shortcut", () => {
    const packet = syntheticPacket();
    packet.invitationGates = [];
    expect(assessCreator(packet, syntheticBinding()).state).toBe("reviewNeeded");
    packet.invitationGates = [{ id: "identity", status: "pass", sourceRef: null }];
    expect(assessCreator(packet, syntheticBinding()).reasonCodes).toContain("INVITE:identity");
  });

  it("never borrows historical weights when no immutable current configuration is bound", () => {
    const result = assessCreator(syntheticPacket(), null);
    expect(result).toMatchObject({ state: "reviewNeeded", contentQualification: "pass", score: null });
    expect(result.config).toEqual({ status: "unbound", version: null, hash: null, baselineHash: null, numericHash: null });
    expect(result).toMatchObject({ policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION });
  });

  it("keeps an otherwise bound model pending when no explicit numeric decision rules are bound", () => {
    const config = syntheticConfig();
    delete config.decisionRules;
    const binding = bindConfig(config, config, digest(config));
    const result = assessCreator(withActivationEvidence(syntheticPacket()), binding);
    expect(result.config.status).toBe("bound");
    expect(result.score?.total).toBe(60);
    expect(result.contentQualification).toBe("pass");
    expect(result.state).toBe("reviewNeeded");
    expect(result.reasonCodes).toContain("DECISION_RULES_BOUND");
  });

  it("requires the explicit bound activation threshold rather than inferring readiness from complete phase gates", () => {
    const config = syntheticConfig();
    config.decisionRules = { invitationMinScore: null, activationMinScore: 77, minCoveragePct: 0 };
    const binding = bindConfig(config, config, digest(config));
    const packet = withActivationEvidence(syntheticPacket());
    const below = assessCreator(packet, binding);
    expect(below.score?.total).toBe(60);
    expect(below.state).toBe("prospectiveInviteEligible");
    expect(below.reasonCodes).toContain("ACTIVATION_NUMERIC_RULES");
    packet.ratings = { routine: 4, demo: 4 };
    const above = assessCreator(packet, binding);
    expect(above.score?.total).toBe(80);
    expect(above.state).toBe("activationReady");
  });

  it("keeps lower-like recent posts in metadata instead of selecting only successful deep-review posts", () => {
    const result = assessCreator(syntheticPacket(), syntheticBinding());
    expect(result.metadata).toMatchObject({ sampleSize: 10, coverage: "complete", medianViews: 450, minViews: 0, maxViews: 900, comparableViewCount: 10 });
    expect(result.packet.qualifyingPosts).toBe(3);
  });
});

describe("immutable current configuration binding", () => {
  it("pins a canonical baseline while allowing a version/approval revision with unchanged numeric meaning", () => {
    const baseline = syntheticConfig();
    const current = { ...structuredClone(baseline), version: "synthetic-config-v2", approvalRef: "synthetic:updated-approval" };
    const binding = bindConfig(current, baseline, digest(baseline));
    expect(binding.hash).not.toBe(binding.baselineHash);
    expect(binding.numericHash).toBe(numericDigest(baseline));
    expect(current.criteria).toEqual(baseline.criteria);
    expect(current.arithmetic).toBe(baseline.arithmetic);
    expect(current.bands).toEqual(baseline.bands);
  });

  it("rejects baseline hash tampering, changed weights/bands/model identity and invented arithmetic", () => {
    const baseline = syntheticConfig();
    expect(() => bindConfig(baseline, baseline, "0".repeat(64))).toThrow("BASELINE_HASH_MISMATCH");
    const weights = structuredClone(baseline);
    weights.criteria[0]!.weight = 44;
    weights.criteria[1]!.weight = 56;
    expect(() => bindConfig(weights, baseline, digest(baseline))).toThrow("NUMERIC_CONFIGURATION_CHANGED");
    const bands = structuredClone(baseline);
    bands.bands[1]!.min = 78;
    expect(() => bindConfig(bands, baseline, digest(baseline))).toThrow("NUMERIC_CONFIGURATION_CHANGED");
    const rules = structuredClone(baseline);
    rules.decisionRules!.activationMinScore = 51;
    expect(() => bindConfig(rules, baseline, digest(baseline))).toThrow("NUMERIC_CONFIGURATION_CHANGED");
    expect(() => bindConfig(syntheticConfig("tiktok-shop"), baseline, digest(baseline))).toThrow("NUMERIC_CONFIGURATION_CHANGED");
    expect(modelConfigSchema.safeParse({ ...baseline, arithmetic: "rescale-known-weights" }).success).toBe(false);
  });

  it("does not invent or rescale missing noncritical configured criterion ratings", () => {
    const config = syntheticConfig();
    config.criteria = [{ ...config.criteria[0]!, weight: 31 }, { ...config.criteria[1]!, weight: 49 }, { id: "synthetic-extra", label: "Synthetic extra criterion", weight: 20 }];
    const binding = bindConfig(config, config, digest(config));
    const result = assessCreator(syntheticPacket(), binding);
    expect(result.score).toMatchObject({ earned: 48, total: null, unknownCount: 1, band: null });
    const packet = syntheticPacket();
    packet.criterionRatings["synthetic-extra"] = 4;
    const unsupported = assessCreator(packet, binding);
    expect(unsupported.score).toMatchObject({ earned: 48, total: null, unknownCount: 1 });
    expect(unsupported.configuration?.criteria.find((criterion) => criterion.id === "synthetic-extra")?.rating).toBeNull();
    packet.criterionEvidenceRefs["synthetic-extra"] = ["synthetic:extra-criterion-proof"];
    expect(assessCreator(packet, binding).score?.total).toBe(64);
  });

  it("never activates on an incomplete weighted total, even with every activation receipt present", () => {
    const config = syntheticConfig();
    config.criteria = [{ ...config.criteria[0]!, weight: 31 }, { ...config.criteria[1]!, weight: 49 }, { id: "synthetic-extra", label: "Synthetic extra criterion", weight: 20 }];
    const binding = bindConfig(config, config, digest(config));
    const packet = withActivationEvidence(syntheticPacket());
    const incomplete = assessCreator(packet, binding);
    expect(incomplete.score).toMatchObject({ earned: 48, total: null, unknownCount: 1 });
    expect(incomplete.state).toBe("prospectiveInviteEligible");
    expect(incomplete.reasonCodes).toContain("ACTIVATION_NUMERIC_RULES");
    packet.criterionRatings["synthetic-extra"] = 4;
    expect(assessCreator(packet, binding).state).toBe("prospectiveInviteEligible");
    packet.criterionEvidenceRefs["synthetic-extra"] = ["synthetic:extra-criterion-proof"];
    expect(assessCreator(packet, binding).state).toBe("activationReady");
  });

  it("excludes unsupported noncritical numbers from the bound coverage rule without changing their weights", () => {
    const config = syntheticConfig();
    config.criteria = [{ ...config.criteria[0]!, weight: 31 }, { ...config.criteria[1]!, weight: 49 }, { id: "synthetic-extra", label: "Synthetic extra criterion", weight: 20 }];
    config.decisionRules!.minCoveragePct = 100;
    const binding = bindConfig(config, config, digest(config));
    const packet = syntheticPacket();
    packet.criterionRatings["synthetic-extra"] = 0;
    const unsupported = assessCreator(packet, binding);
    expect(unsupported.state).toBe("reviewNeeded");
    expect(unsupported.reasonCodes).toContain("INVITE_NUMERIC_RULES");
    expect(unsupported.configuration?.criteria.find((criterion) => criterion.id === "synthetic-extra")).toMatchObject({ weight: 20, rating: null });
    packet.criterionEvidenceRefs["synthetic-extra"] = ["synthetic:verified-zero-rating-proof"];
    const supported = assessCreator(packet, binding);
    expect(supported.state).toBe("prospectiveInviteEligible");
    expect(supported.score).toMatchObject({ total: 48, unknownCount: 0 });
    expect(supported.configuration?.criteria.find((criterion) => criterion.id === "synthetic-extra")).toMatchObject({ weight: 20, rating: 0 });
  });
});
