// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import { deriveCommentStats, reviewCoverage, type EvidencePacket } from "../evidence.ts";
import { protectCommentAuthors } from "../evidencePrivacy.ts";
import { assessCreator } from "../policy.ts";
import { syntheticBinding } from "../testFixtures.ts";
import type { SourcePost, VideoEvidenceSnapshot } from "./contract.ts";
import { fixtureBrief, fixtureMetric, fixtureReviews, fixtureSourcePost, J20_FIXTURE_AT } from "./fixtures.testkit.ts";
import { inferenceRefusals } from "./inferenceScreen.ts";
import { buildCollectedPacket, nativeLikesOf } from "./packet.ts";
import { videoEvidenceQuality } from "./quality.ts";

/** Pure J20 rules over fictional source pages. Storage, runtime and HTTP are covered by videoEvidence.integration.test.ts. */
const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
const protect = (packet: EvidencePacket) => protectCommentAuthors(packet, scope, "synthetic-operations-secret-not-a-secret-0001");
const snapshot = (posts: SourcePost[], extra: Partial<VideoEvidenceSnapshot> = {}): VideoEvidenceSnapshot => ({ receiptRef: "receipt:synthetic-page",
  requestDigest: digest("synthetic"), observedAt: J20_FIXTURE_AT, validUntil: "2026-11-06T13:00:00.000Z", brief: fixtureBrief, listedPosts: posts.length,
  posts, audience: [], nextCursor: null, ...extra });
const collect = (posts: SourcePost[], prior: EvidencePacket | null = null, extra: Partial<VideoEvidenceSnapshot> = {}) =>
  buildCollectedPacket({ creatorId: "synthetic-creator", prior, snapshot: snapshot(posts, extra), collector: { version: "synthetic-collector.v1", stage: "synthetic-fixture" }, protect });
const dated = (n: number, day: number, overrides: Partial<SourcePost> = {}) => fixtureSourcePost(n, { publishedAt: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`, ...overrides });
const assess = (packet: EvidencePacket) => assessCreator(packet, syntheticBinding());
const gates = (packet: EvidencePacket) => Object.fromEntries(assess(packet).gates.filter(g => ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE"].includes(g.id)).map(g => [g.id, g.state]));
const qualityOf = (packet: EvidencePacket) => videoEvidenceQuality({ packet, assessment: assess(packet) })!;
const likes = (value: number | null, rawLabel: string | null, sourceType: SourcePost["likes"]["sourceType"] = "nativePublicCounter") =>
  ({ value, rawLabel, sourceType, sourceRef: "synthetic:likes", missingReason: value === null ? "hidden" as const : null });

describe("J20-13 native-like boundary fixtures through the collector", () => {
  it("deep-reviews 201 only; 199 and 200 fail; hidden, rounded, ambiguous and third-party labels stay pending, never zero", () => {
    expect(nativeLikesOf(likes(201, "201"))).toMatchObject({ status: "known", exact: true, value: 201 });
    expect(nativeLikesOf(likes(1200, "1.2K"))).toMatchObject({ status: "known", exact: false });
    expect(nativeLikesOf(likes(null, "Hidden"))).toMatchObject({ status: "unavailable", rawLabel: "Hidden" });
    expect(nativeLikesOf(likes(201, "200+"))).toMatchObject({ status: "unknown", rawLabel: "200+" });
    expect(nativeLikesOf(likes(201, null))).toMatchObject({ status: "unknown" });
    expect(nativeLikesOf(likes(900, "900", "thirdParty"))).toMatchObject({ status: "unknown" });
    const { packet } = collect([dated(1, 1, { likes: likes(199, "199") }), dated(2, 2, { likes: likes(200, "200") }), dated(3, 3, { likes: likes(201, "201") }),
      dated(4, 4, { likes: likes(null, "Hidden"), review: null }), dated(5, 5, { likes: likes(201, "200+"), review: null })]);
    expect(packet.posts.map(p => p.nativeLikes.rawLabel)).toEqual(["201"]);
    expect(packet.recentPosts.find(p => p.nativeLikes.rawLabel === "Hidden")?.nativeLikes).toMatchObject({ status: "unavailable" });
    expect(packet.recentPosts.every(p => p.nativeLikes.status !== "known" || p.nativeLikes.value !== 0)).toBe(true);
    expect(qualityOf(packet).nextAction).toBe("needsMetricProof");
  });
});

describe("J20-02 modality fixtures keep distinct status and coverage after collection", () => {
  it("stores complete, sampled, caption-only, muted, interrupted and blocked reviews with distinct derived status", () => {
    const names = ["complete", "sampled", "captionOnly", "muted", "interrupted", "blocked"] as const;
    const { packet } = collect(names.map((name, i) => dated(i + 1, i + 1, { review: structuredClone(fixtureReviews[name]) })));
    const byDay = [...packet.posts].sort((a, b) => a.publishedAt!.localeCompare(b.publishedAt!));
    expect(byDay.map(p => { const c = reviewCoverage(p.review); return `${c.viewingStatus}/${c.audioCoverage}`; })).toEqual([
      "completeAudioVisual/heard", "sampledFrames/unassessed", "captionOnly/captionsOnly", "fullVisualOnly/muted", "interrupted/unassessed", "blocked/unassessed"]);
    const footage = qualityOf(packet).footage;
    expect(footage.filter(f => f.nextAction === "needsPlayback").map(f => f.viewingStatus).sort()).toEqual(["blocked", "captionOnly", "interrupted"]);
    expect(footage.find(f => f.viewingStatus === "interrupted")).toMatchObject({ visualSeconds: 12, visualCoveragePct: 40, playbackElapsedSeconds: 12 });
    expect(footage.find(f => f.viewingStatus === "fullVisualOnly")).toMatchObject({ heardSeconds: 0, heardCoveragePct: null });
  });
});

describe("J20-04 / J20-06 packet rules: shown use, dates, CTA and Shop anchor", () => {
  const noUse = () => ({ ...structuredClone(fixtureReviews.complete), observedActions: [{ atSec: 0, action: "Opens on a fictional tote.", meaningfulUse: false, kind: "hook" as const }] });
  it("counts three posts on two dates with two shown brief-matched uses; neither a CTA nor a Shop anchor is required", () => {
    const { packet } = collect([dated(1, 1), dated(2, 1), dated(3, 2, { review: noUse() })]);
    expect(gates(packet)).toEqual({ QUALIFYING_POSTS: "pass", PUBLICATION_DATES: "pass", MEANINGFUL_USE: "pass" });
    expect(packet.posts.every(p => p.shoppableContext?.status === "unknown" && !p.review.observedActions.some(a => a.kind === "cta"))).toBe(true);
    expect(qualityOf(packet).footage[0]!.features.cta).toBe("notObserved");
  });
  it("narrated use never counts as shown use, and a short packet stays needs-evidence rather than failing", () => {
    const narratedOnly = { ...noUse(), narration: [{ atSec: 5, text: "Says she uses it every day.", method: "heard" as const, about: "action" as const }] };
    const { packet } = collect([dated(1, 1), dated(2, 2, { review: narratedOnly }), dated(3, 3, { review: narratedOnly })]);
    expect(gates(packet)).toEqual({ QUALIFYING_POSTS: "pass", PUBLICATION_DATES: "pass", MEANINGFUL_USE: "unknown" });
    const sameDay = collect([dated(1, 1), dated(2, 1), dated(3, 1)]).packet;
    expect(gates(sameDay)).toEqual({ QUALIFYING_POSTS: "pass", PUBLICATION_DATES: "unknown", MEANINGFUL_USE: "pass" });
    const tooFew = collect([dated(1, 1), dated(2, 2)]).packet;
    expect(gates(tooFew).QUALIFYING_POSTS).toBe("unknown");
    expect(assess(tooFew).contentQualification).toBe("reviewNeeded");
    expect(qualityOf(tooFew)).toMatchObject({ packet: { status: "needsEvidence" }, nextAction: "needsPlayback" });
  });
  it("sampled versus full coverage stays visible, and an unopened eligible post is needs-playback, not zero evidence", () => {
    const { packet } = collect([dated(1, 1, { review: structuredClone(fixtureReviews.sampled) }), dated(2, 2, { review: null })]);
    const quality = qualityOf(packet);
    expect(quality.footage.map(f => f.viewingStatus).sort()).toEqual(["notOpened", "sampledFrames"]);
    expect(quality.limitations).toContain("SAMPLED_FRAMES_NOT_CONTINUOUS");
    expect(quality.footage.find(f => f.viewingStatus === "notOpened")).toMatchObject({ nextAction: "needsPlayback",
      features: { hook: "unknown", handlingOperationUse: "unknown", cta: "unknown" } });
  });
});

describe("J20-05 / J20-11 counters and comments keep missing, zero and prompted states apart", () => {
  it("keeps a known zero, a hidden null and prompted comments as observed, and aliases comment authors", () => {
    const { packet } = collect([dated(1, 1, { metrics: [fixtureMetric("views", 0, { rawLabel: "0" }), fixtureMetric("shares", null)] })]);
    const post = packet.posts[0]!;
    expect(post.metrics).toEqual([expect.objectContaining({ key: "views", value: 0, missingReason: null }), expect.objectContaining({ key: "shares", value: null, missingReason: "hidden" })]);
    expect(packet.recentPosts[0]!.views).toMatchObject({ status: "known", value: 0 });
    const stats = deriveCommentStats(post.comments);
    expect(stats).toMatchObject({ status: "observed", observedRows: 2, promptedRows: 1, unpromptedAudienceCategoryCounts: { promptedKeyword: 0, purchaseEvaluation: 1 } });
    expect(JSON.stringify(post.comments)).not.toContain("synthetic-author-1");
    const unknown = collect([dated(1, 1, { comments: { status: "unavailable", reason: "Synthetic comments hidden." } })]).packet;
    expect(deriveCommentStats(unknown.posts[0]!.comments)).toMatchObject({ status: "unavailable", observedRows: null, promptedRows: null });
  });
});

describe("J20-01 / J20-03 versions and preservation", () => {
  it("derives a content revision, reuses identical facts, and returns reviewer ratings to unknown when the reviewed footage changes", () => {
    const first = collect([dated(1, 1), dated(2, 2)]).packet;
    expect(first.evidenceRevision).toMatch(/^j20-[0-9a-f]{32}$/);
    const rated = { ...first, ratings: { routine: 4, demo: 3 } };
    const again = collect([dated(1, 1, { retrievedAt: "2026-11-06T12:30:00.000Z" }), dated(2, 2)], rated, { observedAt: "2026-11-06T12:30:00.000Z", receiptRef: "receipt:later" });
    expect(again.changed).toBe(false);
    expect(again.packet.ratings).toEqual({ routine: 4, demo: 3 });
    const edited = collect([dated(1, 1, { contentFingerprint: "synthetic-fingerprint-1-edited", review: null }), dated(2, 2)], rated);
    expect(edited.changed).toBe(true);
    expect(edited.packet.ratings).toEqual({ routine: null, demo: null });
    // After the changed footage is reviewed again, that review is carried on later reads that do not reopen the clip.
    const rereviewed = collect([dated(1, 1, { contentFingerprint: "synthetic-fingerprint-1-edited" }), dated(2, 2)], edited.packet).packet;
    const carried = collect([dated(1, 1, { contentFingerprint: "synthetic-fingerprint-1-edited", review: null }), dated(2, 2)], rereviewed).packet;
    expect(carried.posts.find(p => p.sourceUrl.endsWith("SYNTHJ201/"))!.review.status).toBe("complete");
  });
  it("starts a new evidence basis for a different brief or route and never merges duplicate source rows", () => {
    const first = collect([dated(1, 1)]).packet;
    const otherBrief = collect([dated(2, 2)], { ...first, ratings: { routine: 5, demo: 5 } }, { brief: { ...fixtureBrief, ref: "synthetic-other-brief" } }).packet;
    expect(otherBrief.posts).toHaveLength(1);
    expect(otherBrief.ratings).toEqual({ routine: null, demo: null });
    expect(() => collect([dated(1, 1), dated(1, 1)])).toThrow("J20_DUPLICATE_SOURCE_POST");
  });
});

describe("J20-07 / J20-09 taxonomy exclusions and the inference screen", () => {
  it("excludes clinical, IVF and medical-education footage from the reviewed packet, with no credit for educator status", () => {
    const { packet } = collect([dated(1, 1, { context: { ...fixtureSourcePost(1).context, exclusion: "ivfFertilityExplainer", educatorOrCredentialed: true } }),
      dated(2, 2, { context: { ...fixtureSourcePost(2).context, primaryBucket: "other" } }), dated(3, 3, { context: { ...fixtureSourcePost(3).context, primaryBucket: "unknown" } })]);
    expect(packet.posts).toEqual([]);
    expect(packet.collection!.exclusions.map(e => e.reasons).sort()).toEqual([["CONTEXT_NOT_LIFESTYLE"], ["CONTEXT_UNKNOWN"], ["EXCLUDED_IVF_FERTILITY_EXPLAINER"]]);
    expect(packet.recentPosts.every(p => !p.relevant)).toBe(true);
  });
  it("refuses health, demographic, purchasing-power and outcome inference but passes ordinary product language", () => {
    for (const text of ["She looks pregnant here.", "The creator has a chronic condition.", "Viewers are probably 25-34 year olds.", "Followers aged 25-34 love it.",
      "Her audience skews older women.", "Affluent buyers can afford it.", "This will cure her back pain.", "Likely to buy after watching."])
      expect(inferenceRefusals([text]).length, text).toBeGreaterThan(0);
    for (const text of ["Race day bag with a rich leather finish.", "Unisex tote packed for a workday.", "Top-down framing; captions legible.", "Shows the zipper closing twice."])
      expect(inferenceRefusals([text]), text).toEqual([]);
    const screened = collect([dated(1, 1, { context: { ...fixtureSourcePost(1).context, secondaryLabels: ["commute", "older women audience"] },
      productionChoices: [{ key: "styling", atSec: 0, observation: "Wealthy households will like this styling.", evidenceRef: "synthetic:style" }],
      review: { ...structuredClone(fixtureReviews.interrupted), interruption: { atSec: 12, reason: "Creator seems depressed, stopped." } } })]).packet;
    const post = screened.posts[0]!;
    expect(post.context!.secondaryLabels).toEqual(["commute"]);
    expect(post.productionChoices).toEqual([]);
    expect(post.review.interruption).toEqual({ atSec: 12, reason: "Interruption reason withheld by the inference screen." });
    expect(screened.collection!.quarantined.map(q => q.field).sort()).toEqual(["context.secondaryLabels[1]", "productionChoices[0].observation", "review.interruption.reason"]);
    expect(JSON.stringify(screened)).not.toMatch(/older women|Wealthy households|seems depressed/);
  });
});
