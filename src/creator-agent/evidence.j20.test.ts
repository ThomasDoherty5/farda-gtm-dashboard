// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "./config.ts";
import {
  audienceEvidenceSchema, evidencePacketSchema, nativeLikesSchema, postEvidenceSchema, postMetricSchema, reviewCoverage, reviewSchema,
  J20_SAMPLING_POLICY_VERSION, J20_TAXONOMY_VERSION, VIDEO_EVIDENCE_SCHEMA_VERSION, type EvidenceCollection, type EvidenceReview,
} from "./evidence.ts";
import { assessCreator } from "./policy.ts";
import { routeAssessmentSchema, resolveScorecardEvidence, sourceSnapshotSchema } from "./routeEvidence.ts";
import { syntheticBinding, syntheticPacket, syntheticSourceSnapshot, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { fixtureContext, fixtureJ20Post, fixtureMetric, fixtureReviews, J20_FIXTURE_AT } from "./videoEvidence/fixtures.testkit.ts";

/** Fictional records only. These schema tests prove the J20 fields version the existing packet without changing old history. */
const collection = (overrides: Partial<EvidenceCollection> = {}): EvidenceCollection => ({
  schemaVersion: VIDEO_EVIDENCE_SCHEMA_VERSION, collectorVersion: "synthetic-collector.v1", collectorStage: "synthetic-fixture",
  samplingPolicyVersion: J20_SAMPLING_POLICY_VERSION, taxonomyVersion: J20_TAXONOMY_VERSION, briefVersion: "v1",
  sourceReceiptRef: "synthetic:receipt", observedAt: J20_FIXTURE_AT, listedPosts: 3, exclusions: [], audience: [], quarantined: [], ...overrides,
});
const j20Packet = () => ({ ...syntheticPacket(), posts: [1, 2, 3].map(n => fixtureJ20Post(n)), collection: collection() });
const review = (overrides: Partial<EvidenceReview>) => ({ ...structuredClone(fixtureReviews.complete), ...overrides });

describe("J20 schema evolution keeps stored history unchanged (J20-11, J20-12)", () => {
  it("parses a pre-J20 packet and stored assessment byte-for-byte, so earlier hashes and receipts still match", () => {
    const legacy = syntheticPacket();
    const reparsed = evidencePacketSchema.parse(JSON.parse(JSON.stringify(legacy)));
    expect(digest(reparsed)).toBe(digest(legacy));
    expect(Object.keys(reparsed)).not.toContain("collection");
    expect(Object.keys(reparsed.posts[0]!)).not.toContain("source");
    const assessment = assessCreator(legacy, syntheticBinding());
    expect(assessment.routeEvidence).not.toHaveProperty("unavailableMetrics");
    expect(routeAssessmentSchema.parse(JSON.parse(JSON.stringify(assessment.routeEvidence)))).toEqual(assessment.routeEvidence);
  });
  it("versions a collected packet: every reviewed post carries source provenance, context, counters and playback facts", () => {
    expect(evidencePacketSchema.parse(j20Packet()).collection?.schemaVersion).toBe("farda.video-evidence.v1");
    const unsourced = j20Packet(); delete unsourced.posts[0]!.source;
    expect(evidencePacketSchema.safeParse(unsourced).success).toBe(false);
    for (const field of ["context", "metrics", "accessObservation"] as const) {
      const missing = fixtureJ20Post(1); delete missing[field];
      expect(postEvidenceSchema.safeParse(missing).success, field).toBe(false);
    }
    const untimed = fixtureJ20Post(1); delete untimed.review.playbackElapsedSeconds;
    expect(postEvidenceSchema.safeParse(untimed).success).toBe(false);
    expect(evidencePacketSchema.safeParse({ ...j20Packet(), collection: collection({ samplingPolicyVersion: "j20-sampling.unapproved" as never }) }).success).toBe(false);
    expect(evidencePacketSchema.safeParse({ ...j20Packet(), collection: collection({ collectorStage: "connected" as never }) }).success).toBe(false);
  });
  it("keeps an excluded post out of the reviewed packet and lists each exclusion once", () => {
    const excluded = collection({ exclusions: [{ postId: "j20-synthetic-1", reasons: ["LIKES_NOT_ABOVE_200"], observedAt: J20_FIXTURE_AT }] });
    expect(evidencePacketSchema.safeParse({ ...j20Packet(), collection: excluded }).success).toBe(false);
    const twice = collection({ exclusions: ["LIKES_NOT_ABOVE_200", "NOT_RELEVANT_TO_BRIEF"].map(reason => ({ postId: "j20-other", reasons: [reason as "LIKES_NOT_ABOVE_200"], observedAt: J20_FIXTURE_AT })) });
    expect(evidencePacketSchema.safeParse({ ...j20Packet(), collection: twice }).success).toBe(false);
  });
});

describe("J20-05 / J20-13 raw native labels: hidden and rounded stay distinct from exact counts", () => {
  it("accepts an exact label that matches, and refuses a rounded or 200+ label stored as exact", () => {
    expect(nativeLikesSchema.safeParse({ status: "known", value: 201, exact: true, sourceRef: "synthetic:likes", rawLabel: "201" }).success).toBe(true);
    expect(nativeLikesSchema.safeParse({ status: "known", value: 1204, exact: true, sourceRef: "synthetic:likes", rawLabel: "1,204" }).success).toBe(true);
    for (const rawLabel of ["1.2K", "200+", "202", "2 01"])
      expect(nativeLikesSchema.safeParse({ status: "known", value: 201, exact: true, sourceRef: "synthetic:likes", rawLabel }).success, rawLabel).toBe(false);
    expect(nativeLikesSchema.safeParse({ status: "known", value: 1200, exact: false, sourceRef: "synthetic:likes", rawLabel: "1.2K" }).success).toBe(true);
    expect(nativeLikesSchema.safeParse({ status: "unavailable", reason: "Native count hidden.", rawLabel: "Hidden" }).success).toBe(true);
  });
  it("keeps a hidden counter null with its reason, never zero, and keeps unit, definition, window and snapshot time", () => {
    const hidden = postMetricSchema.parse(fixtureMetric("shares", null));
    expect(hidden).toMatchObject({ value: null, missingReason: "hidden", rawLabel: "Hidden", unit: "count", observedAt: J20_FIXTURE_AT });
    expect(postMetricSchema.safeParse({ ...hidden, value: 0 }).success).toBe(false);
    expect(postMetricSchema.safeParse({ ...hidden, missingReason: null }).success).toBe(false);
    expect(postMetricSchema.safeParse(fixtureMetric("views", 0)).success).toBe(true);
    expect(postMetricSchema.safeParse(fixtureMetric("views", 1200, { rawLabel: "1.2K" })).success).toBe(false);
    expect(postMetricSchema.safeParse(fixtureMetric("views", 1200, { rawLabel: "1.2K", approximate: true })).success).toBe(true);
    expect(postMetricSchema.safeParse({ ...fixtureMetric("views", 5), definition: undefined }).success).toBe(false);
  });
});

describe("J20-02 / J20-13 review status and modality coverage", () => {
  it("derives a distinct status for complete, sampled, caption-only, muted, interrupted and blocked fixtures", () => {
    const derived = Object.fromEntries(Object.entries(fixtureReviews).map(([name, value]) => {
      const coverage = reviewCoverage(reviewSchema.parse(value));
      return [name, `${coverage.viewingStatus}/${coverage.audioCoverage}`];
    }));
    expect(derived).toEqual({ complete: "completeAudioVisual/heard", sampled: "sampledFrames/unassessed", captionOnly: "captionOnly/captionsOnly",
      muted: "fullVisualOnly/muted", interrupted: "interrupted/unassessed", blocked: "blocked/unassessed" });
    expect(new Set(Object.values(derived)).size).toBe(6);
    expect(reviewCoverage(reviewSchema.parse(fixtureReviews.muted))).toMatchObject({ heardSeconds: 0, heardCoveragePct: null, visualCoveragePct: 100 });
    expect(reviewCoverage(reviewSchema.parse(fixtureReviews.captionOnly))).toMatchObject({ visualSeconds: 0, visualCoveragePct: null, sampledPoints: 0 });
  });
  it("elapsed playback alone cannot pass full-review validation", () => {
    const elapsedOnly = review({ watchedIntervals: [{ startSec: 0, endSec: 10 }], heardIntervals: [], audioMethod: "unassessed", playbackElapsedSeconds: 30,
      observedActions: [] });
    expect(reviewSchema.safeParse(elapsedOnly).success).toBe(false);
    expect(reviewSchema.safeParse({ ...elapsedOnly, durationSeconds: null }).success).toBe(false);
    const honest = reviewSchema.parse({ ...elapsedOnly, status: "partial", sourceRef: null });
    expect(reviewCoverage(honest)).toMatchObject({ viewingStatus: "partialPlayback", visualSeconds: 10, visualCoveragePct: 33.3, playbackElapsedSeconds: 30 });
    // Overlapping or repeated ranges never add coverage.
    const repeated = review({ watchedIntervals: [{ startSec: 0, endSec: 10 }, { startSec: 0, endSec: 10 }, { startSec: 5, endSec: 10 }], heardIntervals: [], audioMethod: "unassessed", observedActions: [] });
    expect(reviewSchema.safeParse(repeated).success).toBe(false);
  });
  it("muted, caption-only and interrupted reviews earn no coverage they did not observe", () => {
    expect(reviewSchema.safeParse({ ...fixtureReviews.muted, heardIntervals: [{ startSec: 0, endSec: 30 }] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.muted, claims: [{ atSec: 3, text: "Says the case is waterproof.", method: "heard" }] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.captionOnly, status: "complete", sourceRef: "synthetic:review" }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.captionOnly, observedActions: [{ atSec: 2, action: "Caption says it fits.", meaningfulUse: true }] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.captionOnly, audioMethod: "heard" }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.interrupted, status: "complete", sourceRef: "synthetic:review" }).success).toBe(false);
  });
  it("refuses timestamps past the clip and a complete sampled review without its clip duration", () => {
    expect(reviewSchema.safeParse(review({ observedActions: [{ atSec: 31, action: "Late action.", meaningfulUse: false, kind: "hook" }] })).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.sampled, sampledPoints: [0, 45] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...fixtureReviews.sampled, durationSeconds: null }).success).toBe(false);
  });
});

describe("J20-04 shown action, narration and interpretation stay separate", () => {
  it("keeps narration out of shown actions, matches its audio method, and lets only shown use count as brief-matched", () => {
    const narrated = reviewSchema.parse(review({ narration: [{ atSec: 8, text: "Says she packs it every morning.", method: "heard", about: "action" }] }));
    expect(narrated.observedActions.map(action => action.kind)).toEqual(["hook", "handlingOperationUse"]);
    expect(narrated.narration).toHaveLength(1);
    expect(reviewSchema.safeParse({ ...fixtureReviews.muted, narration: [{ atSec: 8, text: "Says it fits.", method: "heard", about: "action" }] }).success).toBe(false);
    expect(reviewSchema.safeParse(review({ observedActions: [{ atSec: 1, action: "Shows a retail link.", meaningfulUse: true, kind: "cta" }] })).success).toBe(false);
    expect(reviewSchema.safeParse(review({ observedActions: [{ atSec: 1, action: "Bag closes.", meaningfulUse: false, kind: "visibleOutcome" }] })).success).toBe(true);
    expect(reviewSchema.safeParse({ ...fixtureReviews.blocked, narration: [{ atSec: 1, text: "Unheard.", method: "nativeCaptions", about: "other" }], status: "unassessed" }).success).toBe(false);
  });
});

describe("J20-07 lifestyle taxonomy and exclusions", () => {
  it("cannot mark clinical, IVF/fertility, medical-education, other or unknown content as relevant; educator status is only recorded", () => {
    for (const exclusion of ["clinicalLecture", "ivfFertilityExplainer", "genericMedicalEducation"] as const)
      expect(postEvidenceSchema.safeParse(fixtureJ20Post(1, undefined, { context: fixtureContext({ exclusion }) })).success, exclusion).toBe(false);
    for (const primaryBucket of ["other", "unknown"] as const)
      expect(postEvidenceSchema.safeParse(fixtureJ20Post(1, undefined, { context: fixtureContext({ primaryBucket }) })).success, primaryBucket).toBe(false);
    expect(postEvidenceSchema.safeParse(fixtureJ20Post(1, undefined, { relevant: false, context: fixtureContext({ exclusion: "clinicalLecture", educatorOrCredentialed: true }) })).success).toBe(true);
    const plain = { ...syntheticPacket(), posts: [1, 2, 3].map(n => fixtureJ20Post(n)), collection: collection() };
    const educator = { ...plain, posts: plain.posts.map(post => ({ ...post, context: fixtureContext({ educatorOrCredentialed: true }) })) };
    expect(assessCreator(evidencePacketSchema.parse(educator), syntheticBinding())).toEqual(assessCreator(evidencePacketSchema.parse(plain), syntheticBinding()));
  });
});

describe("J20-08 audience proof is aggregate, authorized and dated", () => {
  const report = { dimension: "countryRegion" as const, buckets: [{ label: "Fictional region A", share: 0.6 }], sourceType: "authorizedNativeAnalytics" as const,
    periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-31T00:00:00Z", observedAt: J20_FIXTURE_AT, provenanceRef: "synthetic:report", verified: true };
  it("verifies only a dated native report or creator export with provenance", () => {
    expect(audienceEvidenceSchema.safeParse(report).success).toBe(true);
    expect(audienceEvidenceSchema.safeParse({ ...report, sourceType: "datedCreatorExport" }).success).toBe(true);
    expect(audienceEvidenceSchema.safeParse({ ...report, sourceType: "publicSelfDescription" }).success).toBe(false);
    expect(audienceEvidenceSchema.safeParse({ ...report, provenanceRef: null }).success).toBe(false);
    expect(audienceEvidenceSchema.safeParse({ ...report, periodStart: null, periodEnd: null }).success).toBe(false);
    expect(audienceEvidenceSchema.safeParse({ ...report, sourceType: "publicSelfDescription", verified: false }).success).toBe(true);
    expect(audienceEvidenceSchema.safeParse({ ...report, buckets: [{ label: "A", share: 0.7 }, { label: "B", share: 0.6 }] }).success).toBe(false);
  });
  it("has no route for face, voice, name, appearance or location inference, on the packet or the provider snapshot", () => {
    for (const sourceType of ["faceInference", "voiceInference", "nameInference", "appearance", "creatorLocation", "inferred"])
      expect(audienceEvidenceSchema.safeParse({ ...report, sourceType }).success, sourceType).toBe(false);
    for (const extra of [{ inferredAge: "25-34" }, { inferredFrom: "face" }, { creatorLocation: "Fictional city" }, { healthStatus: "unknown" }])
      expect(audienceEvidenceSchema.safeParse({ ...report, ...extra }).success).toBe(false);
    const snapshot = syntheticSourceSnapshot(syntheticPacket());
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, audience: { ...snapshot.audience!, sourceType: "datedCreatorExport", provenanceRef: "synthetic:export" } }).success).toBe(true);
    for (const sourceType of ["publicSelfDescription", "faceInference", "creatorLocation"])
      expect(sourceSnapshotSchema.safeParse({ ...snapshot, audience: { ...snapshot.audience!, sourceType } }).success, sourceType).toBe(false);
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, audience: { ...snapshot.audience!, inferredFrom: "voice" } }).success).toBe(false);
  });
});

describe("J20-05 provider metric observations keep missing distinct from zero", () => {
  const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]! };
  const hiddenOrders = { name: "orders" as const, value: null, missingReason: "hidden" as const, unit: "count" as const, currency: null,
    definition: "Fictional attributed orders", denominator: "eligible orders", windowStart: "2020-01-01T00:00:00Z", windowEnd: "2020-02-01T00:00:00Z",
    sampleSize: 0, maturity: "unknown" as const, sourceRef: "synthetic:orders", rawLabel: "Hidden", observedAt: "2020-02-01T00:00:00Z" };
  it("keeps raw label, unit, snapshot time, source definition and refund basis on known metrics", () => {
    const snapshot = syntheticSourceSnapshot(syntheticPacket());
    const metric = { ...snapshot.metrics[0]!, rawLabel: "$25.00", observedAt: "2020-02-01T00:00:00Z", definitionVersion: "synthetic-net-v1",
      sourceType: "nativeReport" as const, refundBasis: "excluded" as const, trafficMix: "organic" as const, postAgeDays: { min: 3, max: 20 } };
    expect(sourceSnapshotSchema.parse({ ...snapshot, metrics: [metric] }).metrics[0]).toMatchObject({ rawLabel: "$25.00", refundBasis: "excluded" });
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, metrics: [{ ...metric, observedAt: "2020-01-15T00:00:00Z" }] }).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, metrics: [{ ...metric, postAgeDays: { min: 9, max: 2 } }] }).success).toBe(false);
  });
  it("records a hidden provider metric as null with its reason, never as a known zero, and carries it into the assessment", async () => {
    const packet = syntheticPacket();
    const snapshot = { ...syntheticSourceSnapshot(packet), unavailableMetrics: [hiddenOrders] };
    expect(sourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, unavailableMetrics: [{ ...hiddenOrders, value: 0 }] }).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, unavailableMetrics: [{ ...hiddenOrders, missingReason: undefined }] }).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse({ ...snapshot, metrics: [{ ...hiddenOrders, value: 0, missingReason: undefined }], unavailableMetrics: [hiddenOrders] }).success).toBe(false);
    const proof = await resolveScorecardEvidence({ resolve: () => snapshot }, scope, packet, Date.parse("2026-02-03T00:00:00Z"));
    const assessment = assessCreator(packet, syntheticBinding(), proof);
    expect(assessment.routeEvidence?.unavailableMetrics).toEqual([hiddenOrders]);
    expect(assessment.routeEvidence?.metrics.some(metric => metric.name === "orders")).toBe(false);
  });
});
