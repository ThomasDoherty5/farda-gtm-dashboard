// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalJson, digest, loadApprovedBindings } from "./config.ts";
import { assessCreator, rescoreOf } from "./policy.ts";
import { resolveScorecardEvidence, type ScorecardSourceSnapshot } from "./routeEvidence.ts";
import { AGENT_VERSION, creatorAssessmentSchema, type CreatorAssessment } from "./assessmentSchema.ts";
import { frozenCases, frozenInput, readFrozen, runFrozen, type FrozenCase } from "./j02Fixtures.testkit.ts";
import { SYNTHETIC_SCOPE } from "./testFixtures.ts";

/** J02-09: exact expected outputs from frozen inputs. Each case's expected output is the frozen base output with its recorded delta. */
const frozen = readFrozen();
const expectedFor = (name: FrozenCase) => ({ ...frozen.expected, ...frozen.cases[name].delta }) as CreatorAssessment;
const binding = loadApprovedBindings().find(b => b.current.modelId === frozen.modelId)!;
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]! };
const feature = (a: CreatorAssessment, name: string) => a.metricCompatibility!.find(f => f.feature === name)!;

describe("J02-09 frozen expected outputs", () => {
  it("binds the owner-approved website configuration and a current, schema-valid expected base", () => {
    expect(binding.hash).toBe(frozen.configHash);
    expect(creatorAssessmentSchema.parse(frozen.expected)).toEqual(frozen.expected);
    expect(frozen.expected).toMatchObject({ state: "activationReady", score: { total: 82, band: "priorityReview" }, calibrationState: "provisional" });
    expect(Object.keys(frozen.cases).sort()).toEqual([...frozenCases].sort());
  });

  it.each(frozenCases)("%s reproduces its exact frozen output", async name => {
    const actual = await runFrozen(frozen.base, name, frozen.nowMs);
    expect(actual).toEqual(expectedFor(name));
    // A delta records only what changed; a stale delta entry would hide a regression.
    for (const [key, value] of Object.entries(frozen.cases[name].delta))
      expect(canonicalJson(value), key).not.toBe(canonicalJson((frozen.expected as Record<string, unknown>)[key]));
  });

  it("replay: identical frozen inputs produce byte-identical outputs across calls and serialization", async () => {
    const first = await runFrozen(frozen.base, "replay", frozen.nowMs);
    const second = await runFrozen(JSON.parse(JSON.stringify(frozen.base)), "replay", frozen.nowMs);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(digest(first)).toBe(digest(frozen.expected));
    expect(frozen.cases.replay.delta).toEqual({});
  });

  it("viral outlier: one extreme post moves the robust median by one rank and changes no gate, score or handoff", () => {
    const a = expectedFor("viralOutlier");
    expect(a.metadata).toMatchObject({ medianViews: 550, minViews: 100, maxViews: 5_000_000, comparableViewCount: 10 });
    expect(Object.keys(frozen.cases.viralOutlier.delta).sort()).toEqual(["metadata", "routeEvidence"]);
  });

  it("missing shares: hidden J20 shares keep the full engagement rate unavailable while every other counter is exact", () => {
    const a = expectedFor("missingShares");
    expect(feature(a, "engagementRate")).toMatchObject({ state: "unavailable", inputCount: 3, reasons: ["SHARES_MISSING"] });
    expect(feature(expectedFor("replay"), "engagementRate").reasons).toEqual(["VIEWS_MISSING", "COMMENT_TOTAL_MISSING", "SHARES_MISSING", "SAVES_MISSING"]);
    const { packet } = frozenInput(frozen.base, "missingShares");
    expect(packet.posts.map(p => p.metrics!.find(m => m.key === "shares"))).toEqual(Array(3).fill(expect.objectContaining({ value: null, missingReason: "hidden" })));
    expect(a).toMatchObject({ state: "activationReady", score: { total: 82 }, packet: { qualifyingPosts: 3 } });
    expect(JSON.stringify(a.metricCompatibility)).not.toMatch(/"value"/);
  });

  it("mixed paid traffic: the reach baseline is incompatible and has no median, while the score is unchanged", () => {
    const a = expectedFor("mixedPaidTraffic");
    expect(feature(a, "reachBaseline")).toMatchObject({ state: "incompatible", dimensions: { trafficClass: "mismatch" }, reasons: expect.arrayContaining(["TRAFFIC_CLASS_MIXED"]) });
    expect(a.metadata).toMatchObject({ medianViews: null, minViews: null, maxViews: null });
    expect(a.routeEvidence!.comparison).toMatchObject({ status: "incomparable", median: null, spread: null });
    // Provider retained sales that include paid traffic stay usable for the rubric, with the mix reported.
    expect(feature(a, "verifiedCommerce")).toMatchObject({ state: "derived", reasons: ["TRAFFIC_INCLUDES_PAID"] });
    expect(a).toMatchObject({ state: "activationReady", score: { total: 82 } });
  });

  it("expired source proof: an expired provider envelope is unknown, never zero, and blocks activation only", () => {
    const a = expectedFor("expiredSourceProof");
    expect(a.routeEvidence).toMatchObject({ status: "unknown", reason: "SOURCE_STALE", audience: null, metrics: [] });
    expect(a.configuration!.criteria.filter(c => c.rating === null).map(c => c.id)).toEqual(["verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"]);
    expect(a).toMatchObject({ state: "prospectiveInviteEligible", score: { total: null, unknownCount: 4 }, scoreBounds: { min: 41, max: 96, total: null },
      offer: { state: "none", reason: "SOURCE_PROOF_UNAVAILABLE" }, nextAction: { recommendation: "prospectiveInviteEligible" } });
  });

  // NEEDS-OWNER: neither the approved scorecard policy nor the route evidence contract sets a maximum age for the audience
  // window itself, so no number is invented here. This pins today's behaviour: an old audience window inside a current
  // provider lease is still credited. An owner decision to age it out will be a visible change to this test.
  it("pins current behaviour: a 2019 audience window inside a current provider lease is still credited", async () => {
    const { packet, source } = frozenInput(frozen.base, "replay");
    source.audience = { ...source.audience!, windowStart: "2019-01-01T00:00:00Z", windowEnd: "2019-02-01T00:00:00Z" };
    const a = assessCreator(packet, binding, await resolveScorecardEvidence({ resolve: () => source }, scope, packet, frozen.nowMs),
      { rescore: { triggers: ["initial"], priorRevision: null } });
    expect(a.routeEvidence!.audience).toMatchObject({ windowEnd: "2019-02-01T00:00:00Z" });
    expect(a.configuration!.criteria.find(c => c.id === "audienceAlignment")!.rating).toBe(4);
    expect(a.state).toBe("activationReady");
  });

  it("incomplete footage: a partial review is not a qualifying post and the handoff returns to the reviewer", () => {
    const a = expectedFor("incompleteFootage");
    expect(a).toMatchObject({ state: "reviewNeeded", contentQualification: "reviewNeeded", packet: { qualifyingPosts: 2 }, reasonCodes: ["QUALIFYING_POSTS"],
      nextAction: { recommendation: "reviewNeeded" } });
  });

  it("changed offer: accepted terms that no longer match the current saved offer cannot support activation", () => {
    const a = expectedFor("changedOffer");
    expect(a).toMatchObject({ state: "prospectiveInviteEligible", reasonCodes: ["SOURCE:terms"], routeEvidence: { reason: "ACCEPTED_OFFER_MISSING_OR_CHANGED", acceptedTerms: null },
      offer: { state: "none", reason: "ACCEPTED_OFFER_MISSING_OR_CHANGED" }, nextAction: { recommendation: "prospectiveInviteEligible" } });
  });
});

/**
 * These two cases need the J11 retained-sales ledger, which does not exist yet. Until it does, these tests
 * prove only that missing or unsettled retained-sales evidence stays unknown, blocks activation and never becomes zero.
 */
describe("J02-09 cases that need the J11 retained-sales ledger", () => {
  async function assess(change: (s: ScorecardSourceSnapshot) => void) {
    const { packet, source } = frozenInput(frozen.base, "replay");
    change(source);
    return assessCreator(packet, binding, await resolveScorecardEvidence({ resolve: () => source }, scope, packet, frozen.nowMs));
  }
  const blocked = (a: CreatorAssessment) => {
    expect(a.configuration!.criteria.find(c => c.id === "verifiedCommerce")!.rating).toBeNull();
    expect(a.score).toMatchObject({ total: null, unknownCount: 1 });
    expect(a.state).not.toBe("activationReady");
    expect(a.dimensions).toMatchObject({ commerceEvidence: "incompatible", financialReadiness: "unavailable" });
    expect(Object.values(a.economics!.fields)).toEqual(Array(9).fill({ state: "unavailable", reason: "J11_RETAINED_SALES_LEDGER_NOT_CONNECTED" }));
    expect(a.nextAction).toMatchObject({ recommendation: "prospectiveInviteEligible" });
  };

  it("duplicated attribution [needs J11]: the same orders reported twice in overlapping windows are not summed", async () => {
    const a = await assess(s => { s.metrics = [s.metrics[0]!, { ...s.metrics[0]!, windowStart: "2020-01-15T00:00:00Z" }]; });
    expect(feature(a, "verifiedCommerce")).toMatchObject({ state: "incompatible", reasons: ["WINDOW_OVERLAP", "TRAFFIC_CLASS_UNKNOWN", "REFUND_BASIS_LEGACY_DEFINITION"] });
    blocked(a);
  });

  it("refund after estimate [needs J11]: an open refund window and a larger GMV figure never stand in for retained sales", async () => {
    const a = await assess(s => { s.metrics = [{ ...s.metrics[0]!, maturity: "open" }, { ...s.metrics[0]!, name: "gmv", value: 99_000, sourceRef: "synthetic:gmv" }]; });
    expect(feature(a, "verifiedCommerce")).toMatchObject({ state: "incompatible", reasons: ["TRAFFIC_CLASS_UNKNOWN", "REFUND_WINDOW_OPEN"] });
    blocked(a);
    expect(JSON.stringify(a.economics)).not.toContain("99000");
  });

  it("unknown retained sales differ from a known zero, and neither fills a J11 economics field", async () => {
    const zero = await assess(s => { s.metrics = [{ ...s.metrics[0]!, value: 0 }]; });
    expect(feature(zero, "verifiedCommerce").state).toBe("derived");
    expect(zero.routeEvidence!.metrics[0]!.value).toBe(0);
    const unknown = await assess(s => { s.metrics = []; });
    expect(feature(unknown, "verifiedCommerce")).toMatchObject({ state: "unavailable", reasons: ["CLAIM_SOURCE_NOT_A_METRIC"] });
    expect(unknown.score).toMatchObject({ total: null, unknownCount: 1 });
    for (const a of [zero, unknown]) expect(a.economics!.fields.retainedNetMerchandise).toEqual({ state: "unavailable", reason: "J11_RETAINED_SALES_LEDGER_NOT_CONNECTED" });
  });
});

describe("rules the snapshot schema itself enforces", () => {
  const base = frozen.expected;
  const override = { annotationRef: "00000000-0000-4000-8000-000000000001", kind: "override", postId: "synthetic-post-1",
    targetRef: "action-0", targetLabel: null, reason: "A synthetic reviewer challenge.", replacement: "A synthetic replacement.", reviewerRef: "agent-reviewer",
    recordedAt: "2026-02-02T00:00:00.000Z", basis: { revision: 1, evidenceRevision: "synthetic-evidence-v1", termsRevision: "synthetic-terms-v1", policyVersion: "2026-11-04",
      modelId: "WEBSITE-AFFILIATE-v3", configHash: null, agentVersion: AGENT_VERSION, rubricVersion: "route-proof.v1" } } as const;
  const withOverride = { reviewerOverrides: [override], reviewerOverrideCount: 1, reasonCodes: [...base.reasonCodes, "REVIEWER_OVERRIDE_OPEN"] };
  it.each([
    ["a held-out calibration claim without held-out evidence", { calibrationState: "heldOutEvaluated" }],
    ["an approved-calibrated claim", { calibrationState: "approvedCalibrated" }],
    ["provisional calibration without a bound operating policy", { calibration: { ...base.calibration!, operatingPolicy: { ...base.calibration!.operatingPolicy, status: "configurationUnbound" } } }],
    ["validated sales prediction", { calibration: { ...base.calibration!, salesPrediction: { status: "validated" } } }],
    ["a retired state that names no prior state", { calibrationState: "retired" }],
    ["a prior state on a configuration that is not retired", { calibration: { ...base.calibration!, retiredFrom: "draft" } }],
    ["a retired state that follows retired", { calibrationState: "retired", calibration: { ...base.calibration!, retiredFrom: "retired" } }],
    ["a retired state that follows a draft", { calibrationState: "retired", calibration: { ...base.calibration!, retiredFrom: "draft" } }],
    ["a retired state that follows an unrecordable held-out state", { calibrationState: "retired", calibration: { ...base.calibration!, retiredFrom: "heldOutEvaluated" } }],
    ["a retired state that follows an unrecordable calibrated state", { calibrationState: "retired", calibration: { ...base.calibration!, retiredFrom: "approvedCalibrated" } }],
    ["a retired unbound configuration", { calibrationState: "retired", calibration: { ...base.calibration!, retiredFrom: "provisional",
      operatingPolicy: { ...base.calibration!.operatingPolicy, status: "configurationUnbound", configVersion: null } } }],
    ["a GMV figure in a J11 economics field", { economics: { ...base.economics!, fields: { ...base.economics!.fields, contributionAfterCosts: { state: "known", value: 99_000 } } } }],
    ["CEO-v1 applied as policy", { economics: { ...base.economics!, policy: { ...base.economics!.policy, appliedAsPolicy: true } } }],
    ["a handoff that dispatches", { nextAction: { ...base.nextAction!, dispatch: "queued" } }],
    ["a handoff that confers approval", { nextAction: { ...base.nextAction!, confersApproval: true } }],
    ["a handoff that sends", { nextAction: { ...base.nextAction!, effects: { ...base.nextAction!.effects, sends: true } } }],
    // The handoff names no J04 phase or requirement: those belong to J04 and the offer eligibility owner.
    ["a handoff that names a J04 phase", { nextAction: { ...base.nextAction!, phase: "activation" } }],
    ["a handoff that lists J04 requirements", { nextAction: { ...base.nextAction!, requires: ["J04_HUMAN_DECISION"] } }],
    ["a current snapshot without its handoff", { nextAction: undefined }],
    ["a current snapshot without its rescore record", { rescore: undefined }],
    ["inverted score bounds", { scoreBounds: { min: 90, max: 80, total: null } }],
    ["a recommendation that differs from the recorded state", { state: "prospectiveInviteEligible" }],
    ["a ready recommendation while a reviewer challenge is open", withOverride],
    ["an open reviewer challenge missing from the blockers", { ...withOverride, reasonCodes: base.reasonCodes, nextAction: { ...base.nextAction!, recommendation: "reviewNeeded" } }],
    ["a review recommendation after a verified hold", { state: "hold", nextAction: { ...base.nextAction!, recommendation: "reviewNeeded" } }],
    ["an override count below the listed challenges", { ...withOverride, reviewerOverrideCount: 0, nextAction: { ...base.nextAction!, recommendation: "reviewNeeded" } }],
    ["unlisted challenges beside a list shorter than the limit", { ...withOverride, reviewerOverrideCount: 2, nextAction: { ...base.nextAction!, recommendation: "reviewNeeded" } }],
    ["a current snapshot without its override count", { reviewerOverrideCount: undefined }],
  ])("rejects %s", (_label, patch) => {
    expect(creatorAssessmentSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("accepts an open challenge recorded as a review recommendation beside the scored state, and a retired configuration that names its prior state", () => {
    expect(creatorAssessmentSchema.safeParse({ ...base, ...withOverride, nextAction: { ...base.nextAction!, recommendation: "reviewNeeded" } }).success).toBe(true);
    expect(creatorAssessmentSchema.safeParse({ ...base, calibrationState: "retired", calibration: { ...base.calibration!, retiredFrom: "provisional" } }).success).toBe(true);
  });

  it("applies the handoff rules to whichever version carries a handoff, not only the current one", () => {
    expect(creatorAssessmentSchema.safeParse({ ...base, agentVersion: "1.1.0", state: "prospectiveInviteEligible" }).success).toBe(false);
    expect(creatorAssessmentSchema.safeParse({ ...base, agentVersion: "1.1.0", calibrationState: "heldOutEvaluated" }).success).toBe(false);
  });
});

describe("rescore reasons are classified, never invented", () => {
  it("records no reason for a direct engine call and classifies writer calls from the stored prior run", () => {
    const { packet } = frozenInput(frozen.base, "replay");
    expect(assessCreator(packet, binding).rescore).toBeNull();
    expect(rescoreOf(null, packet, binding.hash, [], () => true)).toEqual({ triggers: ["initial"], priorRevision: null });
    const prior = { revision: 3, packet, assessment: frozen.expected };
    // An explicit rescore is recorded only when a stored prior run exists and none of its bases changed.
    expect(rescoreOf(prior, packet, binding.hash, [], () => true, frozen.nowMs)).toEqual({ triggers: ["explicitRescore"], priorRevision: 3 });
    expect(rescoreOf(prior, { ...packet, evidenceRevision: "synthetic-evidence-v2" }, binding.hash, [], () => true, frozen.nowMs))
      .toEqual({ triggers: ["evidenceReady"], priorRevision: 3 });
    expect(rescoreOf(prior, packet, "f".repeat(64), [], () => true, frozen.nowMs)).toEqual({ triggers: ["policyChange"], priorRevision: 3 });
  });
});

describe("blockers from J20 claim review and reviewer challenges are both recorded", () => {
  it("keeps CLAIMS_REVIEWED and REVIEWER_OVERRIDE_OPEN in the blockers, and the recommendation follows them", () => {
    const { packet } = frozenInput(frozen.base, "missingShares");
    packet.posts[0]!.review.claims = [{ atSec: 3, text: "A synthetic claim about a medication schedule.", method: "heard", topic: "medical" }];
    const override = { annotationRef: "00000000-0000-4000-8000-000000000002", kind: "disagree" as const, postId: packet.posts[1]!.postId, targetRef: "review",
      targetLabel: null, reason: "A synthetic reviewer disagreement.", replacement: null, reviewerRef: "agent-reviewer", recordedAt: "2026-02-02T00:00:00.000Z",
      basis: { revision: 1, evidenceRevision: packet.evidenceRevision, termsRevision: packet.termsRevision, policyVersion: "2026-11-04",
        modelId: "WEBSITE-AFFILIATE-v3", configHash: binding.hash, agentVersion: AGENT_VERSION, rubricVersion: "route-proof.v1" } };
    const claimOnly = assessCreator(packet, binding, undefined, { rescore: { triggers: ["initial"], priorRevision: null } });
    expect(claimOnly).toMatchObject({ state: "reviewNeeded", reasonCodes: expect.arrayContaining(["CLAIMS_REVIEWED"]), nextAction: { recommendation: "reviewNeeded" } });
    const both = assessCreator(packet, binding, undefined, { reviewerOverrides: [override], rescore: { triggers: ["reviewerOverride"], priorRevision: 1 } });
    expect(both.reasonCodes).toEqual(expect.arrayContaining(["CLAIMS_REVIEWED", "REVIEWER_OVERRIDE_OPEN"]));
    expect(both).toMatchObject({ state: "reviewNeeded", nextAction: { recommendation: "reviewNeeded" } });
    expect(creatorAssessmentSchema.safeParse(both).success).toBe(true);
  });
});

describe("open reviewer challenges beyond the recorded limit", () => {
  it("records the first 100 and the full count, holds the recommendation, and never throws", () => {
    const { packet } = frozenInput(frozen.base, "replay");
    const overrides = Array.from({ length: 101 }, (_, i) => ({ annotationRef: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, kind: "disagree" as const,
      postId: packet.posts[0]!.postId, targetRef: "review", targetLabel: null, reason: "A synthetic reviewer disagreement.", replacement: null,
      reviewerRef: "agent-reviewer", recordedAt: "2026-02-02T00:00:00.000Z", basis: { revision: 1, evidenceRevision: packet.evidenceRevision,
        termsRevision: packet.termsRevision, policyVersion: "2026-11-04", modelId: "WEBSITE-AFFILIATE-v3", configHash: binding.hash, agentVersion: AGENT_VERSION, rubricVersion: "route-proof.v1" } }));
    const a = assessCreator(packet, binding, undefined, { reviewerOverrides: overrides, rescore: { triggers: ["reviewerOverride"], priorRevision: 1 } });
    expect(a.reviewerOverrides).toHaveLength(100);
    expect(a.reviewerOverrides!.at(-1)!.annotationRef).toBe(overrides[99]!.annotationRef);
    expect(a).toMatchObject({ reviewerOverrideCount: 101, reasonCodes: expect.arrayContaining(["REVIEWER_OVERRIDE_OPEN"]), nextAction: { recommendation: "reviewNeeded" } });
    expect(creatorAssessmentSchema.safeParse(a).success).toBe(true);
  });
});

describe("J20 reasons and triggers reach the J02 recommendation", () => {
  it("keeps J20_DETACHED visible without inventing a hold, and the recommendation still follows the scored state", () => {
    const { packet } = frozenInput(frozen.base, "replay");
    const detached = { ...packet, detachedCollection: { fromRevision: 1, fromEvidenceRevision: "synthetic-collected-v1", reason: "Synthetic reviewer detach for a test." } };
    const a = assessCreator(detached, binding, undefined, { rescore: { triggers: ["evidenceReady"], priorRevision: 1 } });
    expect(a.reasonCodes).toContain("J20_DETACHED");
    expect(a.nextAction!.recommendation).toBe(a.state);
    expect(creatorAssessmentSchema.safeParse(a).success).toBe(true);
  });

  it("classifies the server's re-assessment after a claim ruling as reviewerDisposition, never as a caller reason", () => {
    const { packet } = frozenInput(frozen.base, "replay");
    const prior = { revision: 2, packet, assessment: frozen.expected };
    expect(rescoreOf(prior, packet, binding.hash, [], () => true, frozen.nowMs, "reviewerDisposition")).toEqual({ triggers: ["reviewerDisposition"], priorRevision: 2 });
    expect(rescoreOf(prior, { ...packet, evidenceRevision: "d-synthetic" }, binding.hash, [], () => true, frozen.nowMs, "reviewerDisposition"))
      .toEqual({ triggers: ["evidenceReady", "reviewerDisposition"], priorRevision: 2 });
    expect(rescoreOf(prior, packet, binding.hash, [], () => true, frozen.nowMs, "collector")).toEqual({ triggers: ["explicitRescore"], priorRevision: 2 });
  });
});
