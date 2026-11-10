// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceReviewRepository } from "../evidenceReviewStore.ts";
import { evidencePacketSchema } from "../evidence.ts";
import { assessCreator } from "../policy.ts";
import { syntheticBinding } from "../testFixtures.ts";
import { decideClaim, recordKeyOf, type CollectStep } from "./collector.ts";
import { toPostEvidence } from "./rules.ts";
import { feature, likes, metadata, postRef, review, syntheticInput, syntheticService, viewings, SYNTHETIC_J20_SCOPE } from "./fixtures.testkit.ts";
import { VideoEvidenceLedger } from "./ledger.ts";
import { AgentStore } from "../store.ts";

const completed = (step: CollectStep) => { if (step.state !== "completed") throw new Error(`expected completed, got ${step.state}`); return step; };
const AT = "2026-11-08T12:30:00.000Z";
const medicalClaim = { claim_id: "synthetic-claim-1", topic: "medical" as const, video_timestamp: 9, channel: "narrated" as const, method: "heard" as const,
  summary: "Narration mentions a fictional comfort benefit.", human_review: { status: "pending" as const, reviewer: null, decided_at: null } };

describe("J20-01 versioned records, identity, provenance and idempotency", () => {
  it("creates a versioned record with canonical identity, source route, review policy, retrieval time and provenance", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    const step = completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    const record = s.ledger.latest(recordKeyOf(syntheticInput(1), postRef(1)))!;
    expect(record.keys).toMatchObject({ platform: "instagram", creator_source_id: "synthetic-creator-1", post_source_id: "SYNTH1", canonical_post_key: "instagram:SYNTH1", evidence_version: 1 });
    expect(record.source).toMatchObject({ route: "public_native_ui", permission_ref: "synthetic-permission-1", retrieved_at: "2026-11-08T12:00:00.000Z", evidence_refs: ["synthetic:post-read:1"] });
    expect(record.review_policy).toEqual({ sampling_policy_version: "j20-sampling.2026-11-04.v1", taxonomy_version: "j20-lifestyle-taxonomy.v1", policy_version: "2026-11-04" });
    expect(record).toMatchObject({ schema_version: "farda.video-evidence.v1", collector_version: "j20-collector.v1" });
    expect(step.receipts[0]).toMatchObject({ version: 1, reused: false, recordedAt: "2026-11-08T13:00:00.000Z", evidenceRef: "instagram:SYNTH1:v1" });
    expect(step.output.evidenceRecordRefs).toEqual(["instagram:SYNTH1:v1"]);
  });
  it("uses a controlled URL fingerprint when the native post ID is missing, never an invented ID", async () => {
    const s = syntheticService();
    const input = syntheticInput(1, { postRefs: [{ ...postRef(1), sourceId: null }] });
    s.reader.meta.set("SYNTH1", { state: "observed", observation: metadata(1, { post_source_id: null }) });
    s.reader.readPost = async () => ({ state: "observed", observation: metadata(1, { post_source_id: null }) });
    s.reader.reviewPost = async () => ({ state: "observed", review: review() });
    completed(await s.collector.collect(input, { cursor: null, maxRecords: 10 }));
    const record = s.ledger.latest(recordKeyOf(input, input.postRefs[0]!))!;
    expect(record.keys.canonical_post_key).toMatch(/^fp:instagram:[a-f0-9]{40}$/);
    expect(record.keys.post_source_id).toBeNull();
  });
  it("repeated identical work reuses evidence without duplicate observations, and a retried key returns its receipt", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    const first = completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    s.advance(60_000);
    const retry = completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    expect(retry.receipts[0]).toEqual({ ...first.receipts[0], reused: true });
    const later = completed(await s.collector.collect(syntheticInput(1, { idempotencyKey: "synthetic-j20-run-2" }), { cursor: null, maxRecords: 10 }));
    expect(later.receipts[0]).toMatchObject({ version: 1, reused: true });
    const key = recordKeyOf(syntheticInput(1), postRef(1));
    expect(s.ledger.history(key)).toHaveLength(1);
    expect(s.store.database.prepare("SELECT COUNT(*) AS n FROM video_evidence_records").get()?.n).toBe(1);
  });
  it("refuses a reused request key for different work and keeps every stored row immutable", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    const changed = syntheticInput(1, { briefRef: { ref: "synthetic-brief-other", version: "v1" } });
    await expect(s.collector.collect(changed, { cursor: null, maxRecords: 10 })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(() => s.store.database.exec("UPDATE video_evidence_records SET body='{}'")).toThrow(/VIDEO_EVIDENCE_IMMUTABLE/);
    expect(() => s.store.database.exec("DELETE FROM video_evidence_records")).toThrow(/VIDEO_EVIDENCE_IMMUTABLE/);
  });
  it("shares the scoped agent SQLite file and refuses a different workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "farda-j20-"));
    try {
      const path = join(dir, "agent.sqlite");
      new AgentStore(path, SYNTHETIC_J20_SCOPE).close();
      const store = new AgentStore(path, SYNTHETIC_J20_SCOPE);
      expect(() => new VideoEvidenceLedger(store, { workspaceId: "synthetic-other", accountId: "synthetic-account" })).toThrow("DATABASE_SCOPE_MISMATCH");
      new VideoEvidenceLedger(store, SYNTHETIC_J20_SCOPE);
      const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'video_evidence_%' ORDER BY name").all().map((r) => r.name);
      expect(tables).toEqual(["video_evidence_access_events", "video_evidence_meta", "video_evidence_records", "video_evidence_requests", "video_evidence_stages"]);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("J20-02 review status and modality coverage through the collector", () => {
  it.each([
    ["complete", "complete_audio_visual", "review_complete"],
    ["sampled", "sampled_playback", "review_complete"],
    ["captionOnly", "metadata_only", "needs_playback"],
    ["muted", "full_visual_only", "review_complete"],
    ["interrupted", "partial_playback", "needs_playback"],
    ["elapsedOnly", "partial_playback", "needs_playback"],
  ] as const)("%s footage -> %s / %s", async (fixture, status, next) => {
    const s = syntheticService();
    const rev = review(viewings[fixture]);
    // A caption-only or partial review cannot place a shown observation outside what was seen.
    if (fixture === "captionOnly" || fixture === "interrupted" || fixture === "elapsedOnly") rev.features = rev.features.filter((f) => f.feature_key === "cta" || (f.video_timestamp ?? 99) <= 10 && fixture !== "captionOnly");
    s.reader.observe(1, {}, rev);
    completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    const record = s.ledger.latest(recordKeyOf(syntheticInput(1), postRef(1)))!;
    expect(record.viewing?.status).toBe(status);
    expect(record.next_action).toBe(next);
    const j02 = toPostEvidence(record)!;
    expect(j02.review.status === "complete").toBe(next === "review_complete");
    if (fixture === "sampled") expect(j02.review).toMatchObject({ visualMethod: "sampledFrames", watchedIntervals: [], sampledPoints: [0, 5, 10, 20] });
  });
  it("labels sampled frames, machine transcripts and unassessed audio as limitations", async () => {
    const s = syntheticService();
    s.reader.observe(1, {}, review(viewings.sampled)).observe(2, {}, review(viewings.machineTranscript));
    completed(await s.collector.collect(syntheticInput(2), { cursor: null, maxRecords: 10 }));
    expect(s.ledger.latest(recordKeyOf(syntheticInput(2), postRef(1)))!.limitations).toEqual(expect.arrayContaining(["SAMPLED_FRAMES_NOT_CONTINUOUS", "AUDIO_UNASSESSED"]));
    expect(s.ledger.latest(recordKeyOf(syntheticInput(2), postRef(2)))!.limitations).toContain("MACHINE_TRANSCRIPT_NOT_HEARD_AUDIO");
  });
});

describe("J20-03 source loss, login, MFA, removal, change and denied permission", () => {
  it.each([["loginRequired", "SOURCE_LOGIN_REQUIRED"], ["mfaRequired", "SOURCE_MFA_REQUIRED"], ["permissionDenied", "SOURCE_PERMISSION_DENIED"], ["unavailable", "SOURCE_READ_UNAVAILABLE"]] as const)(
    "%s preserves prior evidence, records the failure and resumes from the last valid post", async (state, code) => {
      const s = syntheticService();
      s.reader.observe(1).observe(2).observe(3);
      const input = syntheticInput(3);
      completed(await s.collector.collect(input, { cursor: null, maxRecords: 10 }));
      const before = s.ledger.history(recordKeyOf(input, postRef(2)));
      s.reader.meta.set("SYNTH2", { state, source_ref: "synthetic:source-attempt", observed_at: AT, reason_code: code });
      s.reader.calls.length = 0;
      const second = syntheticInput(3, { idempotencyKey: "synthetic-j20-run-2" });
      const blocked = await s.collector.collect(second, { cursor: null, maxRecords: 10 });
      expect(blocked).toMatchObject({ state: "blocked", failure: { state, reason_code: code } });
      if (blocked.state !== "blocked") throw new Error("blocked");
      expect(s.ledger.history(recordKeyOf(input, postRef(2)))).toEqual(before);
      expect(s.ledger.accessEvents(recordKeyOf(input, postRef(2)))).toMatchObject([{ state, reasonCode: code, observedAt: AT }]);
      expect(s.reader.calls).not.toContain("review:SYNTH2");
      s.reader.observe(2);
      s.reader.calls.length = 0;
      completed(await s.collector.collect(second, { cursor: blocked.cursor, maxRecords: 10 }));
      expect(s.reader.calls).toEqual(["read:SYNTH2", "review:SYNTH2", "read:SYNTH3", "review:SYNTH3"]);
    });
  it("a failure during playback review is recorded without storing a metadata-only substitute", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    s.reader.reviews.set("SYNTH1", { state: "loginRequired", source_ref: "synthetic:player", observed_at: AT, reason_code: "SOURCE_LOGIN_REQUIRED" });
    expect((await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 })).state).toBe("blocked");
    expect(s.ledger.history(recordKeyOf(syntheticInput(1), postRef(1)))).toEqual([]);
  });
  it("a removed post becomes a new version and earlier evidence stays readable", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    s.reader.meta.set("SYNTH1", { state: "removed", source_ref: "synthetic:removed", observed_at: AT });
    const step = completed(await s.collector.collect(syntheticInput(1, { idempotencyKey: "synthetic-j20-run-2" }), { cursor: null, maxRecords: 10 }));
    const history = s.ledger.history(recordKeyOf(syntheticInput(1), postRef(1)));
    expect(history.map((r) => [r.keys.evidence_version, r.source.access_state, r.next_action])).toEqual([[1, "permitted", "review_complete"], [2, "removed", "source_unavailable"]]);
    expect(history[0]!.features.length).toBeGreaterThan(0);
    expect(history[1]).toMatchObject({ features: [], viewing: null, deep_review: { credit: false }, prior_version: 1 });
    expect(step.output.nextAction).toBe("sourceUnavailable");
  });
  it("a changed post (new fingerprint) needs a new review and keeps the old version", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    s.reader.observe(1, { source_content_fingerprint: "synthetic-fp-1-edited" }, review(viewings.interrupted, { features: [] }));
    completed(await s.collector.collect(syntheticInput(1, { idempotencyKey: "synthetic-j20-run-2" }), { cursor: null, maxRecords: 10 }));
    const history = s.ledger.history(recordKeyOf(syntheticInput(1), postRef(1)));
    expect(history.map((r) => [r.source.access_state, r.next_action])).toEqual([["permitted", "review_complete"], ["changed", "needs_playback"], ["permitted", "needs_playback"]]);
  });
  it("an invalid reader response, a changed identity or an out-of-scope permission stores nothing", async () => {
    for (const reply of [{ state: "observed", observation: { invented: true } }, { state: "observed", observation: metadata(1, { post_source_id: "SYNTH999" }) },
      { state: "observed", observation: metadata(1, { permission_ref: "synthetic-permission-other" }) }]) {
      const s = syntheticService();
      s.reader.meta.set("SYNTH1", reply);
      await expect(s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 })).rejects.toMatchObject({ code: expect.stringMatching(/SOURCE_RESPONSE_INVALID|SOURCE_IDENTITY_MISMATCH|SOURCE_PERMISSION_NOT_IN_SCOPE/) });
      expect(s.store.database.prepare("SELECT COUNT(*) AS n FROM video_evidence_records").get()?.n).toBe(0);
    }
  });
  it("checkpoints at the record bound and refuses a cursor from different input", async () => {
    const s = syntheticService();
    s.reader.observe(1).observe(2).observe(3);
    const first = await s.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 2 });
    expect(first).toMatchObject({ state: "checkpoint", recordCount: 2 });
    if (first.state !== "checkpoint") throw new Error("checkpoint");
    await expect(s.collector.collect(syntheticInput(2), { cursor: first.nextCursor, maxRecords: 2 })).rejects.toMatchObject({ code: "CHECKPOINT_INPUT_MISMATCH" });
    let step: CollectStep = first, steps = 1;
    while (step.state === "checkpoint") { step = await s.collector.collect(syntheticInput(3), { cursor: step.nextCursor, maxRecords: 2 }); steps++; }
    expect(step.state).toBe("completed");
    expect(steps).toBe(3);
    expect(s.store.database.prepare("SELECT COUNT(*) AS n FROM video_evidence_records").get()?.n).toBe(3);
  });
});

describe("J20-04 timestamped observations separate from narration and interpretation", () => {
  it("keeps shown action, narration and reviewer interpretation apart; narration never becomes a shown action", async () => {
    const s = syntheticService();
    const rev = review(viewings.complete);
    rev.features.push(feature("explanation", 12, "narrated", "Narration says the fictional case fits any bag."));
    s.reader.observe(1, {}, rev);
    // A second post whose only handling is narrated, not shown.
    s.reader.observe(2, {}, review(viewings.complete, { features: [feature("handling_operation_use", 6, "narrated", "Narration says she uses the case daily.", { brief_match: "matched" })] }));
    completed(await s.collector.collect(syntheticInput(2), { cursor: null, maxRecords: 10 }));
    const first = s.ledger.latest(recordKeyOf(syntheticInput(2), postRef(1)))!;
    const handling = first.features.find((f) => f.feature_key === "handling_operation_use")!;
    expect(handling).toMatchObject({ channel: "shown", video_timestamp: 6, exact_observation: "Unzips a fictional case and places it in the tote.", interpretation: { text: "Reviewer reads this as an on-brief travel use." } });
    expect(first.features.find((f) => f.feature_key === "visible_outcome")?.causality).toBe("unresolved");
    const j02 = toPostEvidence(first)!;
    expect(j02.review.observedActions).toEqual([{ atSec: 6, action: "Unzips a fictional case and places it in the tote.", meaningfulUse: true }]);
    expect(j02.review.inferences).toEqual(["Reviewer reads this as an on-brief travel use."]);
    expect(toPostEvidence(s.ledger.latest(recordKeyOf(syntheticInput(2), postRef(2)))!)!.review.observedActions).toEqual([]);
  });
  it("needs neither a retail CTA nor a Shop anchor, and flags a shown observation outside the observed range", async () => {
    const s = syntheticService();
    s.reader.observe(1).observe(2, {}, review(viewings.interrupted));
    completed(await s.collector.collect(syntheticInput(2), { cursor: null, maxRecords: 10 }));
    const ok = s.ledger.latest(recordKeyOf(syntheticInput(2), postRef(1)))!;
    expect(ok.next_action).toBe("review_complete");
    expect(ok.limitations).toEqual(expect.arrayContaining(["NO_RETAIL_CTA_NOT_REQUIRED", "SHOP_LINKAGE_UNPROVEN_NOT_REQUIRED"]));
    const outside = s.ledger.latest(recordKeyOf(syntheticInput(2), postRef(2)))!;
    expect(outside.limitations).toContain("SHOWN_FEATURE_OUTSIDE_OBSERVED_RANGE");
    expect(outside.next_action).toBe("needs_playback");
    expect(toPostEvidence(outside)!.review.observedActions).toEqual([{ atSec: 6, action: "Unzips a fictional case and places it in the tote.", meaningfulUse: true }]);
  });
});

describe("J20-05 visible metric fields only", () => {
  it("keeps hidden shares and missing views null with their reasons in the run output", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    const step = completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    const shares = step.output.metricObservations.find((m) => m.metric_key === "shares")!;
    expect(shares).toMatchObject({ value: null, missing_reason: "hidden", raw_display: null });
    expect(step.output.metricObservations.find((m) => m.metric_key === "likes")).toMatchObject({ value: 201, raw_display: "201" });
    expect(step.output.limitations).toContain("METRIC_FIELDS_MISSING");
  });
});

describe("J20-06 / J20-13 deep-review gate, packet and metadata baseline", () => {
  it("deep-reviews 201 but not 199 or 200; lower-like posts join the baseline as metadata only", async () => {
    const s = syntheticService();
    s.reader.observe(1, { likes: likes(199) }).observe(2, { likes: likes(200) }).observe(3, { likes: likes(201) });
    const step = completed(await s.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 10 }));
    expect(s.reader.calls).toEqual(["read:SYNTH1", "read:SYNTH2", "read:SYNTH3", "review:SYNTH3"]);
    const [r199, r200, r201] = [1, 2, 3].map((n) => s.ledger.latest(recordKeyOf(syntheticInput(3), postRef(n)))!);
    for (const r of [r199!, r200!]) {
      expect(r).toMatchObject({ like_gate: { state: "fail" }, deep_review: { eligible: false, credit: false, metadata_only: true }, viewing: null, features: [] });
      expect(r.comments.sample.status).toBe("unknown");
      expect(toPostEvidence(r)).toBeNull();
    }
    expect(r201).toMatchObject({ like_gate: { state: "pass", value: 201 }, deep_review: { eligible: true, credit: true, metadata_only: false } });
    expect(step.output.contentMixAssessment).toMatchObject({ requested: 3, accessible: 3, eligible: 1, reviewed: 1, metadataOnly: 2, pendingLikeProof: 0,
      baseline: { selected: 3, coverage: "partial" }, packet: { status: "needsEvidence", qualifyingPosts: 1 } });
  });
  it("keeps hidden and rounded like labels pending with needs-metric-proof and no review", async () => {
    const s = syntheticService();
    s.reader.observe(1, { likes: likes(null, "Hidden") }).observe(2, { likes: likes(4100, "4.1K", { approximate: true }) });
    const step = completed(await s.collector.collect(syntheticInput(2), { cursor: null, maxRecords: 10 }));
    expect(s.reader.calls.filter((c) => c.startsWith("review"))).toEqual([]);
    expect(step.output.nextAction).toBe("needsMetricProof");
    expect(step.output.contentMixAssessment).toMatchObject({ pendingLikeProof: 2, eligible: 0 });
  });
  it("a packet of 3 relevant reviewed posts on 2+ dates with 2 action posts passes the J02 content gates", async () => {
    const s = syntheticService();
    s.reader.observe(1).observe(2).observe(3, {}, review(viewings.complete, { features: [feature("hook", 0, "shown", "Opens on a fictional desk.")] }));
    const step = completed(await s.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 10 }));
    expect(step.output.contentMixAssessment).toMatchObject({ packet: { status: "packetComplete", qualifyingPosts: 3, publicationDates: 3, meaningfulUsePosts: 2 } });
    expect(step.output.nextAction).toBe("reviewComplete");
  });
  it("insufficient publication dates or action posts stay needs-evidence, not zero", async () => {
    const sameDay = syntheticService();
    for (const n of [1, 2, 3]) sameDay.reader.observe(n, { published_at: "2026-10-05T09:00:00.000Z" });
    const one = completed(await sameDay.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 10 }));
    expect(one.output.contentMixAssessment).toMatchObject({ packet: { status: "needsEvidence", publicationDates: 1 } });
    expect(one.output.nextAction).toBe("needsPlayback");
    expect(one.output.limitations).toContain("PACKET_NEEDS_EVIDENCE");
    const noAction = syntheticService();
    const narrated = review(viewings.complete, { features: [feature("handling_operation_use", 6, "narrated", "Narration describes the fictional case.", { brief_match: "matched" })] });
    noAction.reader.observe(1).observe(2, {}, narrated).observe(3, {}, narrated);
    const two = completed(await noAction.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 10 }));
    expect(two.output.contentMixAssessment).toMatchObject({ packet: { status: "needsEvidence", qualifyingPosts: 3, meaningfulUsePosts: 1 } });
  });
  it("exposes post ages, paid and pinned state; Shop linkage is not required for content sourcing", async () => {
    const s = syntheticService();
    s.reader.observe(1, { pinned: true, paid: "yes" }).observe(2, { pinned: null, paid: "unknown" });
    const step = completed(await s.collector.collect(syntheticInput(2), { cursor: null, maxRecords: 10 }));
    const mix = step.output.contentMixAssessment as { posts: unknown[]; shopLinkageRequired: boolean; baseline: { reasons: string[] } };
    expect(mix.posts).toEqual([
      { evidenceRef: "instagram:SYNTH1:v1", ageDays: 38, pinned: true, paid: "yes", likeGate: "pass" },
      { evidenceRef: "instagram:SYNTH2:v1", ageDays: 37, pinned: null, paid: "unknown", likeGate: "pass" },
    ]);
    expect(mix.shopLinkageRequired).toBe(false);
    expect(mix.baseline.reasons).toEqual(expect.arrayContaining(["INSUFFICIENT_KNOWN_POSTS", "UNKNOWN_PINNED_STATE"]));
  });
});

describe("J20-07 lifestyle classification in the run", () => {
  it("excludes clinical content even above the like gate and reports counts, never percentages or weights", async () => {
    const s = syntheticService();
    s.reader.observe(1).observe(2, { context: { primary_bucket: "workday", secondary_labels: [], excluded_topics: ["clinical_lecture"], educator_or_credentialed: true, selection_reason: "ordinary_recent" } });
    const step = completed(await s.collector.collect(syntheticInput(2), { cursor: null, maxRecords: 10 }));
    expect(s.reader.calls).not.toContain("review:SYNTH2");
    expect(step.output.contentMixAssessment).toMatchObject({ bucketCounts: { travel_purse: 1 }, exclusions: [{ evidenceRef: "instagram:SYNTH2:v1", reasons: ["EXCLUDED_CLINICAL_LECTURE"] }] });
    expect(JSON.stringify(step.output.contentMixAssessment)).not.toMatch(/percent|weight|allocation/i);
  });
});

describe("J20-08 audience evidence in the run", () => {
  it("an unverified self-description does not satisfy a required audience proof", async () => {
    const s = syntheticService();
    const self = { evidence_id: "synthetic-aud", dimension: "language" as const, value: null, source_type: "public_self_description" as const, period: null,
      observed_at: AT, provenance_ref: null, verified: false, limits: "No face-, voice-, name- or health-status inference; public creator location is not audience-share evidence." as const };
    s.reader.observe(1, {}, review(viewings.complete, { audience: [self] }));
    const step = completed(await s.collector.collect(syntheticInput(1, { reviewRequirements: { audienceProofRequired: true, packetRequired: false } }), { cursor: null, maxRecords: 10 }));
    expect(step.output.nextAction).toBe("needsAudienceProof");
    expect(step.output.limitations).toContain("PUBLIC_SELF_DESCRIPTION_NOT_AUDIENCE_PROOF");
  });
});

describe("J20-09 uncertain claims take the human exception path", () => {
  it("routes a medical claim to human review, refuses an agent decision, and appends a reviewer decision", async () => {
    const s = syntheticService();
    s.reader.observe(1, {}, review(viewings.complete, { claims: [medicalClaim] }));
    const step = completed(await s.collector.collect(syntheticInput(1, { reviewRequirements: { audienceProofRequired: false, packetRequired: false } }), { cursor: null, maxRecords: 10 }));
    expect(step.output.nextAction).toBe("needsClaimReview");
    expect(step.output.claimsReview).toMatchObject([{ evidenceRef: "instagram:SYNTH1:v1", claim: { topic: "medical", human_review: { status: "pending" } } }]);
    const key = recordKeyOf(syntheticInput(1), postRef(1));
    const request = { recordKey: key, expectedVersion: 1, claimId: "synthetic-claim-1", decision: "rejected" as const, requestKey: "synthetic-decision-1" };
    expect(() => decideClaim(s.ledger, { ...request, actor: { id: "synthetic-agent", role: "agent" } })).toThrow("HUMAN_REVIEWER_REQUIRED");
    expect(() => decideClaim(s.ledger, { ...request, expectedVersion: 7, actor: { id: "synthetic-reviewer", role: "reviewer" }, requestKey: "synthetic-decision-stale" })).toThrow("STALE_VERSION");
    const receipt = decideClaim(s.ledger, { ...request, actor: { id: "synthetic-reviewer", role: "reviewer" } });
    expect(receipt).toMatchObject({ version: 2, reused: false });
    const history = s.ledger.history(key);
    expect(history[0]!.claims[0]!.human_review.status).toBe("pending");
    expect(history[1]!.claims[0]!.human_review).toEqual({ status: "rejected", reviewer: "synthetic-reviewer", decided_at: "2026-11-08T13:00:00.000Z" });
    expect(history[1]!.next_action).toBe("review_complete");
  });
  it("hands the claim to the existing reviewer annotation store as a J02 review target", async () => {
    const s = syntheticService();
    s.reader.observe(1, {}, review(viewings.complete, { claims: [medicalClaim] })).observe(2).observe(3);
    completed(await s.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 10 }));
    const posts = [1, 2, 3].map((n) => toPostEvidence(s.ledger.latest(recordKeyOf(syntheticInput(3), postRef(n)))!)!);
    const packet = evidencePacketSchema.parse({ creatorId: "synthetic-creator-1", briefId: "synthetic-brief-travel-case", checkoutRoute: "website",
      evidenceRevision: "synthetic-j20-v1", termsRevision: "synthetic-terms-v1", posts, recentPosts: [], ratings: { routine: 4, demo: 4 }, invitationGates: [], activationGates: [] });
    const assessment = assessCreator(packet, syntheticBinding());
    expect(assessment.gates.filter((g) => ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE"].includes(g.id)).map((g) => g.state)).toEqual(["pass", "pass", "pass"]);
    s.store.save(packet, assessment, 0, "synthetic-j20-save");
    const reviews = new EvidenceReviewRepository(s.store, SYNTHETIC_J20_SCOPE, (record, superseded = false) => ({ ...record, stale: superseded }));
    const read = reviews.read("synthetic-creator-1", posts[0]!.postId)!;
    expect(read.data.sourceReview.targets.map((t) => t.id)).toEqual(expect.arrayContaining(["review", "action-0", "claim-0", "inference-0"]));
  });
});

describe("J20-11 buyer/viewer comment evidence", () => {
  it("keeps declared n, order, time, prompted flags and categories; missing samples stay unknown", async () => {
    const s = syntheticService();
    s.reader.observe(1).observe(2, {}, review(viewings.complete, { comments: { sample: { status: "unavailable", reason: "Synthetic comments disabled." }, declared_n: null, source_ref: "synthetic:comments", visible_author_count: null } }))
      .observe(3, {}, review(viewings.complete, { comments: { sample: { status: "observed", ordering: "Source order", observedAt: AT, rows: [] }, declared_n: 0, source_ref: "synthetic:comments", visible_author_count: 0 } }));
    const step = completed(await s.collector.collect(syntheticInput(3), { cursor: null, maxRecords: 10 }));
    const comments = (step.output.contentMixAssessment as { comments: { postId: string; status: string; observedRows: number | null; promptedRows: number | null; categoryCounts: Record<string, number> | null }[] }).comments;
    expect(comments[0]).toMatchObject({ status: "observed", observedRows: 2, promptedRows: 1, categoryCounts: { purchaseEvaluation: 1, promptedKeyword: 1, selfReportedOwnership: 0 } });
    expect(comments[1]).toMatchObject({ status: "unavailable", observedRows: null, promptedRows: null, categoryCounts: null });
    // An inspected-sample zero is zero only within that sample.
    expect(comments[2]).toMatchObject({ status: "observed", observedRows: 0, categoryCounts: { purchaseEvaluation: 0 } });
  });
});

describe("J20-12 source-linked packet fields", () => {
  it("records brief, canonical post/date, gate, actions, method/ranges, coverage, comments and production choices", async () => {
    const s = syntheticService();
    s.reader.observe(1);
    completed(await s.collector.collect(syntheticInput(1), { cursor: null, maxRecords: 10 }));
    const record = s.ledger.latest(recordKeyOf(syntheticInput(1), postRef(1)))!;
    expect(record).toMatchObject({ brief: { ref: "synthetic-brief-travel-case", version: "v1" }, source: { published_at: "2026-10-01T12:00:00.000Z" },
      like_gate: { state: "pass", raw_label: "201" }, viewing: { method: "continuous_native_playback", status: "complete_audio_visual", visual_coverage_percent: 100 },
      production_choices: [{ key: "framing", observation: "Top-down framing of the bag." }], comments: { declared_n: 2 } });
  });
});
