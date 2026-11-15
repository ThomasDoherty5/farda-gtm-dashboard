// @vitest-environment node
import { describe, expect, it } from "vitest";
import { commerceCompatibility, engagementCompatibility, metricFeatureSchema, reachCompatibility } from "./metricCompatibility.ts";
import { assessCreator } from "./policy.ts";
import { loadApprovedBindings } from "./config.ts";
import { deriveMetadataBaseline, evidencePacketSchema, type EvidencePacket } from "./evidence.ts";
import { resolveScorecardEvidence, type ScorecardSourceSnapshot } from "./routeEvidence.ts";
import { syntheticMetadata, syntheticPacket, syntheticSourceSnapshot, withActivationEvidence, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { fixtureContext, fixtureJ20Post, fixtureMetric, fixtureReviews } from "./videoEvidence/fixtures.testkit.ts";
import type { PostMetric } from "./evidence.ts";

const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]! };
const at = Date.parse("2026-02-03T00:00:00Z");
const binding = loadApprovedBindings().find(b => b.current.modelId === "WEBSITE-AFFILIATE-v3")!;
function approvedPacket(): EvidencePacket {
  const packet = withActivationEvidence(syntheticPacket("website"));
  return evidencePacketSchema.parse({ ...packet, ratings: { routine: 5, demo: 4 },
    criterionRatings: { verifiedCommerce: 3, audienceAlignment: 4, reliability: 4, offerEconomics: 4 },
    criterionEvidenceRefs: Object.fromEntries(["verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"].map(id => [id, [`synthetic:criterion-proof:${id}`]])) });
}
const ref = "synthetic:criterion-proof:verifiedCommerce";
async function assess(mutate: (s: ScorecardSourceSnapshot) => void = () => {}) {
  const packet = approvedPacket();
  const snapshot = syntheticSourceSnapshot(packet, packet.criterionRatings);
  mutate(snapshot);
  return assessCreator(packet, binding, await resolveScorecardEvidence({ resolve: () => snapshot }, scope, packet, at));
}
const metric = (patch: Partial<ScorecardSourceSnapshot["metrics"][number]> = {}): ScorecardSourceSnapshot["metrics"][number] => ({
  ...syntheticSourceSnapshot(approvedPacket()).metrics[0]!, ...patch });
// The base measurement is January 2020; `next` is the following calendar month, February 2020 (29 days).
const next = { windowStart: "2020-02-01T00:00:00Z", windowEnd: "2020-03-01T00:00:00Z" } as const;

describe("J02-05 commerce metric compatibility before verifiedCommerce is derived", () => {
  it("derives the approved single mature retained-sales measurement and keeps its weighted result", async () => {
    const a = await assess();
    // A pre-J20 measurement has no traffic mix; that stays a reported caveat because the rubric does not restrict it.
    // Its refund basis is inferred from the retained-sales definition, not declared, and the verdict says so.
    expect(a.metricCompatibility![0]).toEqual({ feature: "verifiedCommerce", state: "derived", inputCount: 1, reasons: ["TRAFFIC_CLASS_UNKNOWN", "REFUND_BASIS_LEGACY_DEFINITION"],
      dimensions: { unit: "match", numeratorDenominator: "match", window: "match", cohort: "match", postAge: "notApplicable",
        trafficClass: "unknown", sourceDefinition: "match", refundBasis: "match" } });
    expect(a).toMatchObject({ state: "activationReady", score: { total: 82 }, dimensions: { commerceEvidence: "verified" } });
  });

  it.each([
    ["currency", [metric(), metric({ currency: "EUR", ...next })], "unit", "CURRENCY_MISMATCH"],
    ["denominator", [metric(), metric({ denominator: "all creator orders", ...next })], "numeratorDenominator", "DENOMINATOR_MISMATCH"],
    ["gross numerator", [metric({ name: "gmv" })], "numeratorDenominator", "NUMERATOR_NOT_RETAINED"],
    ["overlapping windows", [metric(), metric({ windowStart: "2020-01-15T00:00:00Z", windowEnd: "2020-02-15T00:00:00Z" })], "window", "WINDOW_OVERLAP"],
    ["empty cohort", [metric({ sampleSize: 0 })], "cohort", "COHORT_EMPTY"],
    ["source definition", [metric(), metric({ definition: "Net of refunds after 60 days", ...next })], "sourceDefinition", "SOURCE_DEFINITION_MISMATCH"],
    ["open refund window", [metric({ maturity: "open" })], "refundBasis", "REFUND_WINDOW_OPEN"],
    // J20 provenance: a declared basis must agree with the measure and across every cited window.
    ["refund-inclusive retained figure", [metric({ refundBasis: "included" })], "refundBasis", "REFUND_BASIS_GROSS"],
    ["refund basis", [metric({ refundBasis: "excluded" }), metric({ refundBasis: "notApplicable", ...next })], "refundBasis", "REFUND_BASIS_MISMATCH"],
    ["definition version", [metric({ definitionVersion: "net-v1" }), metric({ definitionVersion: "net-v2", ...next })], "sourceDefinition", "SOURCE_DEFINITION_MISMATCH"],
    ["source type", [metric({ sourceType: "nativeReport" }), metric({ sourceType: "derived", ...next })], "sourceDefinition", "SOURCE_DEFINITION_MISMATCH"],
    ["numerator key", [metric({ numeratorKey: "net-merchandise" }), metric({ numeratorKey: "net-merchandise-and-shipping", ...next })], "numeratorDenominator", "NUMERATOR_MISMATCH"],
    ["traffic classification", [metric({ trafficMix: "organic" }), metric({ trafficMix: "paid", ...next })], "trafficClass", "TRAFFIC_CLASS_INCONSISTENT"],
  ] as const)("refuses an incompatible %s and never derives the criterion", async (_label, metrics, dimension, reason) => {
    const a = await assess(s => { s.metrics = [...metrics]; s.observedAt = next.windowEnd; });
    const commerce = a.metricCompatibility![0]!;
    expect(commerce.state).toBe("incompatible");
    expect(commerce.dimensions[dimension]).toBe("mismatch");
    expect(commerce.reasons).toContain(reason);
    expect(a.configuration!.criteria.find(c => c.id === "verifiedCommerce")!.rating).toBeNull();
    expect(a.score).toMatchObject({ total: null, unknownCount: 1 });
    expect(a.state).not.toBe("activationReady");
    expect(a.dimensions!.commerceEvidence).toBe("incompatible");
  });

  it.each([["maturity", { maturity: "unknown" }, "REFUND_MATURITY_UNKNOWN"], ["declared basis", { refundBasis: "unknown" }, "REFUND_BASIS_UNKNOWN"]] as const)(
    "keeps an unknown refund %s unverified rather than assuming retained sales are final", async (_label, patch, reason) => {
      const a = await assess(s => { s.metrics = [metric(patch)]; });
      expect(a.metricCompatibility![0]).toMatchObject({ state: "unverified", reasons: ["TRAFFIC_CLASS_UNKNOWN", reason], dimensions: { refundBasis: "unknown" } });
      expect(a.configuration!.criteria.find(c => c.id === "verifiedCommerce")!.rating).toBeNull();
    });

  // NEEDS-OWNER: the bound rubric does not say whether paid-traffic retained sales count. This pins today's behaviour,
  // so an owner decision to restrict it is a visible change rather than a silent one.
  it("pins current behaviour: fully paid retained sales still derive verifiedCommerce and reach activation, with the mix reported", async () => {
    const a = await assess(s => { s.metrics = [metric({ trafficMix: "paid" })]; });
    expect(a.metricCompatibility![0]).toMatchObject({ state: "derived", reasons: ["TRAFFIC_INCLUDES_PAID", "REFUND_BASIS_LEGACY_DEFINITION"], dimensions: { trafficClass: "unknown" } });
    expect(a).toMatchObject({ state: "activationReady", score: { total: 82 }, dimensions: { commerceEvidence: "verified" } });
  });

  it("reports provider retained sales that include paid traffic without restricting the rubric, and needs no caveat for organic", async () => {
    const mixed = await assess(s => { s.metrics = [metric({ trafficMix: "mixed", refundBasis: "excluded" })]; });
    expect(mixed.metricCompatibility![0]).toMatchObject({ state: "derived", reasons: ["TRAFFIC_INCLUDES_PAID"], dimensions: { trafficClass: "unknown" } });
    expect(mixed.configuration!.criteria.find(c => c.id === "verifiedCommerce")!.rating).toBe(3);
    const organic = await assess(s => { s.metrics = [metric({ trafficMix: "organic", refundBasis: "excluded", observedAt: "2020-02-01T00:00:00Z" })]; });
    expect(organic.metricCompatibility![0]).toMatchObject({ state: "derived", reasons: [], dimensions: { trafficClass: "match", refundBasis: "match" } });
  });

  it("keeps a hidden cited retained-sales figure unavailable instead of zero", async () => {
    const a = await assess(s => { s.metrics = []; s.unavailableMetrics = [{ ...metric(), value: null, missingReason: "hidden" }]; });
    expect(a.metricCompatibility![0]).toMatchObject({ state: "unavailable", reasons: ["CITED_METRIC_UNAVAILABLE"] });
    expect(a.score).toMatchObject({ total: null, unknownCount: 1 });
    expect(a.routeEvidence!.unavailableMetrics![0]!.value).toBeNull();
  });

  it("derives repeated non-overlapping calendar months as separate observations, reporting their different lengths", async () => {
    const a = await assess(s => { s.metrics = [metric(), metric({ ...next, value: 0 })]; s.observedAt = next.windowEnd; });
    expect(a.metricCompatibility![0]).toMatchObject({ state: "derived", inputCount: 2, reasons: ["WINDOW_LENGTH_DIFFERS", "TRAFFIC_CLASS_UNKNOWN", "REFUND_BASIS_LEGACY_DEFINITION"], dimensions: { window: "match" } });
    expect(a).toMatchObject({ state: "activationReady", score: { total: 82 } });
  });

  // NEEDS-OWNER: no approved period-granularity rule exists, so even a one-day window beside a month is reported, not blocked.
  // Only overlap blocks, because it would count the same orders twice.
  it("pins current behaviour: windows of very different length are a reported caveat, not a block", async () => {
    const a = await assess(s => { s.metrics = [metric(), metric({ windowStart: "2020-02-01T00:00:00Z", windowEnd: "2020-02-02T00:00:00Z" })]; s.observedAt = next.windowEnd; });
    expect(a.metricCompatibility![0]).toMatchObject({ state: "derived", reasons: expect.arrayContaining(["WINDOW_LENGTH_DIFFERS"]) });
    expect(a.state).toBe("activationReady");
  });

  it("keeps the earlier rule for measurements that predate a declared refund basis, and refuses to compare declared with undeclared", async () => {
    // The approved-baseline input declares no refund basis: its retained-sales name and mature window still decide.
    const legacy = await assess();
    expect(legacy.metricCompatibility![0]).toMatchObject({ state: "derived", dimensions: { refundBasis: "match" }, reasons: expect.arrayContaining(["REFUND_BASIS_LEGACY_DEFINITION"]) });
    expect(legacy).toMatchObject({ state: "activationReady", score: { total: 82 } });
    // A declared basis is a checked match and carries no legacy caveat.
    const declared = await assess(s => { s.metrics = [metric({ refundBasis: "excluded" })]; });
    expect(declared.metricCompatibility![0]).toMatchObject({ state: "derived", dimensions: { refundBasis: "match" } });
    expect(declared.metricCompatibility![0]!.reasons).not.toContain("REFUND_BASIS_LEGACY_DEFINITION");
    const undeclared = await assess(s => { s.metrics = [metric(), metric({ ...next })]; s.observedAt = next.windowEnd; });
    expect(undeclared.metricCompatibility![0]).toMatchObject({ state: "derived", dimensions: { refundBasis: "match" } });
    const mixed = await assess(s => { s.metrics = [metric({ refundBasis: "excluded" }), metric({ ...next })]; s.observedAt = next.windowEnd; });
    expect(mixed.metricCompatibility![0]).toMatchObject({ state: "unverified", reasons: expect.arrayContaining(["REFUND_BASIS_UNDECLARED"]), dimensions: { refundBasis: "unknown" } });
    expect(mixed.configuration!.criteria.find(c => c.id === "verifiedCommerce")!.rating).toBeNull();
  });

  it("distinguishes no source proof, no claim and a claim that cites no measurement", () => {
    expect(commerceCompatibility(null, [ref])).toMatchObject({ state: "unavailable", reasons: ["SOURCE_PROOF_UNAVAILABLE"] });
    const s = syntheticSourceSnapshot(approvedPacket(), approvedPacket().criterionRatings);
    expect(commerceCompatibility(s, null)).toMatchObject({ state: "unavailable", reasons: ["RETAINED_SALES_CLAIM_MISSING"] });
    expect(commerceCompatibility(s, ["synthetic:not-a-metric"])).toMatchObject({ state: "unavailable", reasons: ["CLAIM_SOURCE_NOT_A_METRIC"] });
  });
});

describe("J02-05 reach and engagement features", () => {
  const rows = () => Array.from({ length: 10 }, (_, i) => syntheticMetadata(i + 1));
  const reachOf = (input: ReturnType<typeof rows>) => reachCompatibility(deriveMetadataBaseline(input));
  it("derives one-basis organic views and retains the missing post-age watermark as a caveat", () => {
    expect(reachOf(rows())).toEqual({ feature: "reachBaseline", state: "derived", inputCount: 10, reasons: ["POST_AGE_SNAPSHOT_UNAVAILABLE"],
      dimensions: { unit: "match", numeratorDenominator: "notApplicable", window: "match", cohort: "match", postAge: "unknown",
        trafficClass: "match", sourceDefinition: "match", refundBasis: "notApplicable" } });
  });

  it.each([
    ["paid and organic", (r: ReturnType<typeof rows>) => { r[0]!.paid = "yes"; }, "trafficClass", "TRAFFIC_CLASS_MIXED"],
    ["known and unknown traffic", (r: ReturnType<typeof rows>) => { r[0]!.paid = "unknown"; }, "trafficClass", "TRAFFIC_CLASS_PARTIALLY_UNKNOWN"],
    ["view definitions", (r: ReturnType<typeof rows>) => { r[0]!.views = { status: "known", value: 1, definition: "plays", window: "lifetime at synthetic snapshot" }; }, "sourceDefinition", "SOURCE_DEFINITION_MISMATCH"],
    ["view windows", (r: ReturnType<typeof rows>) => { r[0]!.views = { status: "known", value: 1, definition: "synthetic native video views", window: "first 7 days" }; }, "window", "WINDOW_MISMATCH"],
  ] as const)("explains mixed %s from the baseline's own groups", (_label, change, dimension, reason) => {
    const input = rows(); change(input);
    expect(reachOf(input)).toMatchObject({ state: "incompatible", reasons: expect.arrayContaining([reason]) });
    expect(reachOf(input).dimensions[dimension]).toBe("mismatch");
    const a = assessCreator(evidencePacketSchema.parse({ ...syntheticPacket(), recentPosts: input }), binding);
    expect(a.metadata).toMatchObject({ medianViews: null, minViews: null, maxViews: null });
    expect(a.routeEvidence!.comparison).toMatchObject({ status: "incomparable", median: null, spread: null });
  });

  it("is a verdict on the existing baseline, never a second grouping: derived exactly when that baseline has a median", () => {
    const variants: ((r: ReturnType<typeof rows>) => void)[] = [() => {}, r => { r[0]!.paid = "yes"; }, r => { r.forEach(x => { x.paid = "unknown"; }); },
      r => { r[3]!.views = { status: "unknown", reason: "Synthetic hidden views." }; }, r => { r.splice(4); }, r => { r.forEach(x => { x.views = { status: "unavailable", reason: "Synthetic outage." }; }); },
      r => { r[2]!.views = { status: "known", value: 9, definition: "plays", window: "lifetime at synthetic snapshot" }; }, r => { r[1]!.pinned = null; }];
    for (const change of variants) {
      const input = rows(); change(input);
      const baseline = deriveMetadataBaseline(input), verdict = reachCompatibility(baseline);
      expect(verdict.state === "derived").toBe(baseline.viewStats.median !== null);
      expect(verdict.inputCount).toBe(verdict.state === "unavailable" ? 0 : baseline.viewStats.knownCount);
      const a = assessCreator(evidencePacketSchema.parse({ ...syntheticPacket(), recentPosts: input }), binding);
      expect(a.metadata.medianViews).toBe(baseline.viewStats.median);
      expect(a.routeEvidence!.comparison.median).toBe(baseline.viewStats.median);
      expect(a.metricCompatibility![1]).toEqual(verdict);
    }
  });

  it("keeps uniformly unknown traffic as a reported caveat, consistent with the existing single-basis summary", () => {
    const input = rows().map(r => ({ ...r, paid: "unknown" as const }));
    expect(reachOf(input)).toMatchObject({ state: "derived", reasons: ["POST_AGE_SNAPSHOT_UNAVAILABLE", "TRAFFIC_CLASS_UNKNOWN"] });
    expect(assessCreator(evidencePacketSchema.parse({ ...syntheticPacket(), recentPosts: input }), binding).routeEvidence!.comparison).toMatchObject({ paid: "unknown", median: 450 });
  });

  const sameDay = "2026-10-05T12:00:00.000Z";
  const counters = (n: number, patch: Partial<PostMetric> = {}) => (["views", "comments", "shares", "saves"] as const)
    .map(key => fixtureMetric(key, key === "views" ? 1000 + n : 10 + n, patch));
  // Three posts published the same UTC day, so their cumulative counters are the same age at the snapshot.
  const full = () => [1, 2, 3].map(n => fixtureJ20Post(n, fixtureReviews.complete, { metrics: counters(n), publishedAt: sameDay }));

  it("never derives a full engagement rate when shares are hidden or counters were never collected", () => {
    const hiddenShares = [1, 2, 3].map(n => fixtureJ20Post(n));
    expect(engagementCompatibility(hiddenShares)).toMatchObject({ state: "unavailable", reasons: ["COMMENT_TOTAL_MISSING", "SHARES_MISSING", "SAVES_MISSING"] });
    // Pre-J20 packets carry no per-post counters: a sampled comment list is not a total and recent-post views are a different basis.
    expect(engagementCompatibility(syntheticPacket().posts).reasons).toEqual(["VIEWS_MISSING", "COMMENT_TOTAL_MISSING", "SHARES_MISSING", "SAVES_MISSING"]);
    const hiddenLikes = full(); hiddenLikes[0]!.nativeLikes = { status: "unknown", reason: "Synthetic hidden count.", rawLabel: "Hidden" };
    expect(engagementCompatibility(hiddenLikes).reasons).toEqual(["LIKES_MISSING"]);
    expect(engagementCompatibility([]).reasons).toEqual(["LIKES_MISSING", "VIEWS_MISSING", "COMMENT_TOTAL_MISSING", "SHARES_MISSING", "SAVES_MISSING"]);
  });

  it("permits the rate only from one exact snapshot, window, definition and traffic class per post", () => {
    expect(engagementCompatibility(full())).toMatchObject({ state: "derived", reasons: [], inputCount: 3 });
    const rounded = full(); rounded[0]!.metrics![0] = fixtureMetric("views", 1200, { rawLabel: "1.2K", approximate: true });
    expect(engagementCompatibility(rounded)).toMatchObject({ state: "unverified", reasons: ["COUNT_APPROXIMATE"] });
    const later = full(); later[1]!.metrics![2] = fixtureMetric("shares", 12, { observedAt: "2026-11-09T12:00:00.000Z" });
    expect(engagementCompatibility(later)).toMatchObject({ state: "incompatible", reasons: ["POST_AGE_MISMATCH"] });
    const window = full(); window[2]!.metrics = counters(3, { window: "first 7 days" });
    expect(engagementCompatibility(window)).toMatchObject({ state: "incompatible", reasons: ["WINDOW_MISMATCH"] });
    const paid = full(); paid[0]!.context = fixtureContext({ paid: "yes" });
    expect(engagementCompatibility(paid)).toMatchObject({ state: "incompatible", reasons: ["TRAFFIC_CLASS_MIXED"] });
    const unknownPaid = full().map(p => ({ ...p, context: fixtureContext({ paid: "unknown" }) }));
    expect(engagementCompatibility(unknownPaid)).toMatchObject({ state: "unverified", reasons: ["TRAFFIC_CLASS_UNKNOWN"] });
    const definition = full(); definition[1]!.metrics = counters(2, { definition: "synthetic native plays v2" });
    expect(engagementCompatibility(definition)).toMatchObject({ state: "incompatible", reasons: ["SOURCE_DEFINITION_MISMATCH"] });
  });

  // NEEDS-OWNER: no approved age-normalization rule exists, so different post ages leave the rate unverified rather than
  // incompatible. Clearly invalid ages (observed before publication, undated) are still refused.
  it("leaves post age unverified for posts of different ages, including two years apart, and never derives the rate", () => {
    const apart = full(); apart[0]!.publishedAt = "2024-10-05T12:00:00.000Z";
    expect(engagementCompatibility(apart)).toMatchObject({ state: "unverified", reasons: ["POST_AGE_NOT_NORMALIZED"], dimensions: { postAge: "unknown" } });
    const nextDay = full(); nextDay[2]!.publishedAt = "2026-10-06T12:00:00.000Z";
    expect(engagementCompatibility(nextDay)).toMatchObject({ state: "unverified", reasons: ["POST_AGE_NOT_NORMALIZED"] });
    const future = full(); future[0]!.publishedAt = "2026-11-20T12:00:00.000Z";
    expect(engagementCompatibility(future)).toMatchObject({ state: "incompatible", reasons: expect.arrayContaining(["POST_AGE_MISMATCH"]) });
    // The same UTC publication day is the same age, whatever the hour.
    const sameAge = full(); sameAge[1]!.publishedAt = "2026-10-05T01:00:00.000Z";
    expect(engagementCompatibility(sameAge).state).toBe("derived");
    const undated = full(); undated[0]!.publishedAt = null;
    expect(engagementCompatibility(undated)).toMatchObject({ state: "unverified", reasons: ["POST_AGE_SNAPSHOT_UNAVAILABLE"] });
  });

  it("refuses a zero-view denominator instead of deriving an undefined rate", () => {
    const zero = full(); zero[1]!.metrics![0] = fixtureMetric("views", 0);
    expect(engagementCompatibility(zero)).toMatchObject({ state: "incompatible", reasons: ["VIEWS_ZERO_DENOMINATOR"], dimensions: { numeratorDenominator: "mismatch" } });
  });

  it("rejects a verdict that claims derivation over a mismatch or drops its reason", () => {
    const derived = reachOf(rows());
    expect(metricFeatureSchema.safeParse({ ...derived, dimensions: { ...derived.dimensions, window: "mismatch" } }).success).toBe(false);
    expect(metricFeatureSchema.safeParse({ ...engagementCompatibility([]), reasons: [] }).success).toBe(false);
    expect(metricFeatureSchema.safeParse({ ...derived, reasons: ["TRAFFIC_CLASS_MIXED"] }).success).toBe(false);
    // A required dimension that is unknown cannot be relabelled derived, and an unused dimension cannot be claimed as checked.
    expect(metricFeatureSchema.safeParse({ ...derived, dimensions: { ...derived.dimensions, sourceDefinition: "unknown" } }).success).toBe(false);
    expect(metricFeatureSchema.safeParse({ ...derived, dimensions: { ...derived.dimensions, refundBasis: "match" } }).success).toBe(false);
    const commerce = commerceCompatibility(syntheticSourceSnapshot(approvedPacket(), approvedPacket().criterionRatings), [ref]);
    expect(metricFeatureSchema.safeParse({ ...commerce, dimensions: { ...commerce.dimensions, refundBasis: "unknown" }, reasons: ["REFUND_BASIS_UNKNOWN"] }).success).toBe(false);
    expect(metricFeatureSchema.safeParse({ ...commerce, state: "unverified", dimensions: { ...commerce.dimensions, refundBasis: "unknown" }, reasons: ["REFUND_BASIS_UNKNOWN"] }).success).toBe(true);
  });
});
