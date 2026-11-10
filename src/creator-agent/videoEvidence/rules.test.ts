// @vitest-environment node
import { describe, expect, it } from "vitest";
import { audienceProofState, classifyContext, deriveViewing, likeGateOf } from "./rules.ts";
import {
  audienceEvidenceSchema, commentEvidenceSchema, metricObservationSchema, postReviewSchema, videoEvidenceRecordSchema, viewingInputSchema,
  type AudienceEvidence, type ContextInput,
} from "./schema.ts";
import { likes, metric, review, viewings } from "./fixtures.testkit.ts";

describe("J20 native-like gate: strictly more than 200 native visible likes", () => {
  it.each([
    [199, "fail", "NATIVE_LIKES_NOT_ABOVE_200"],
    [200, "fail", "NATIVE_LIKES_NOT_ABOVE_200"],
    [201, "pass", "NATIVE_LIKES_ABOVE_200"],
  ] as const)("%i exact native likes -> %s", (value, state, reason) => {
    const gate = likeGateOf(likes(value));
    expect(gate).toMatchObject({ state, reason_code: reason, parsed: "exact", value, raw_label: String(value) });
  });
  it("keeps hidden, absent, rounded, ambiguous and third-party labels pending, never zero and never a pass", () => {
    const cases = [
      [likes(null, "Hidden"), "hidden"],
      [likes(null, null, { missing_reason: "not_collected" }), "absent"],
      [likes(1200, "1.2K", { approximate: true }), "rounded"],
      [likes(200, "200+"), "ambiguous"],
      [likes(201, "200"), "ambiguous"],
      [likes(201, "201", { approximate: true }), "ambiguous"],
      [likes(5000, "5000", { source_type: "third_party" }), "third_party"],
    ] as const;
    for (const [m, parsed] of cases) {
      const gate = likeGateOf(m);
      expect(gate.state, parsed).toBe("pending");
      expect(gate.parsed).toBe(parsed);
      expect(gate.value).toBeNull();
      expect(gate.raw_label).toBe(m.raw_display);
    }
  });
  it("accepts thousands separators only when the raw label matches the exact value", () => {
    expect(likeGateOf(likes(1201, "1,201")).state).toBe("pass");
    expect(likeGateOf(likes(1201, "1,200")).state).toBe("pending");
  });
});

describe("J20 metric observations keep missing distinct from zero", () => {
  it("requires a missing reason for every null and refuses a reason beside a value", () => {
    expect(metricObservationSchema.safeParse(metric("shares", null, null, { missing_reason: "hidden" })).success).toBe(true);
    expect(metricObservationSchema.safeParse(metric("shares", null, null, { missing_reason: null })).success).toBe(false);
    expect(metricObservationSchema.safeParse(metric("shares", 0, "0", { missing_reason: "hidden" })).success).toBe(false);
    expect(metricObservationSchema.safeParse(metric("shares", 0, "0")).success).toBe(true);
  });
  it("retains the raw label, unit, snapshot time and source definition", () => {
    const m = metricObservationSchema.parse(metric("views", 1500, "1.5K", { approximate: true }));
    expect(m).toMatchObject({ raw_display: "1.5K", unit: "count", observed_at: expect.any(String), definition_version: "synthetic-views-v1", source_type: "native_public_counter" });
  });
  it("refuses an unexplained derived metric", () => {
    expect(metricObservationSchema.safeParse(metric("views", 3, "3", { source_type: "derived" })).success).toBe(false);
  });
});

describe("J20 viewing status and modality coverage", () => {
  it.each([
    ["complete", "complete_audio_visual", 100, 100],
    ["sampled", "sampled_playback", null, null],
    ["captionOnly", "metadata_only", 0, null],
    ["muted", "full_visual_only", 100, null],
    ["interrupted", "partial_playback", 40, null],
    ["notOpened", "not_opened", 0, null],
    ["machineTranscript", "full_visual_only", 100, null],
  ] as const)("%s fixture -> %s", (fixture, status, visual, heard) => {
    const viewing = deriveViewing(viewingInputSchema.parse(viewings[fixture]));
    expect(viewing.status).toBe(status);
    expect(viewing.visual_coverage_percent).toBe(visual);
    expect(viewing.heard_coverage_percent).toBe(heard);
  });
  it("elapsed playback alone cannot pass full-review validation", () => {
    const viewing = deriveViewing(viewings.elapsedOnly);
    expect(viewing.playback_elapsed_seconds).toBe(30);
    expect(viewing.status).toBe("partial_playback");
    expect(viewing.visual_coverage_percent).toBe(33.3);
    const noRanges = deriveViewing({ ...viewings.elapsedOnly, observed_intervals: [] });
    expect(noRanges.status).toBe("not_opened");
  });
  it("sampled frames are points and cannot be recorded as continuous playback", () => {
    const sampled = viewings.sampled;
    expect(viewingInputSchema.safeParse({ ...sampled, observed_intervals: [...sampled.observed_intervals, { start_seconds: 0, end_seconds: 30, modality: "visual_continuous", evidence_ref: "synthetic:x" }] }).success).toBe(false);
    expect(viewingInputSchema.safeParse({ ...sampled, observed_intervals: [{ start_seconds: 0, end_seconds: 5, modality: "visual_frame", evidence_ref: "synthetic:x" }] }).success).toBe(false);
    expect(deriveViewing(sampled).sampled_point_count).toBe(4);
  });
  it("a machine transcript is not heard audio, and unassessed audio stays unknown", () => {
    expect(viewingInputSchema.safeParse({ ...viewings.machineTranscript, audio_state: "heard" }).success).toBe(false);
    expect(viewingInputSchema.safeParse({ ...viewings.machineTranscript, audio_method: "heard" }).success).toBe(false);
    expect(viewingInputSchema.safeParse({ ...viewings.muted, audio_state: "heard" }).success).toBe(false);
    expect(viewingInputSchema.safeParse({ ...viewings.sampled, audio_state: "caption_only" }).success).toBe(false);
    const transcript = deriveViewing(viewings.machineTranscript);
    expect(transcript.audio_state).toBe("unknown");
    expect(transcript.status).not.toBe("complete_audio_visual");
  });
  it("a heard claim needs heard audio, and a collector cannot resolve a claim", () => {
    const claim = { claim_id: "synthetic-claim", topic: "medical" as const, video_timestamp: 9, channel: "narrated" as const, method: "heard" as const,
      summary: "Narration mentions a fictional comfort benefit.", human_review: { status: "pending" as const, reviewer: null, decided_at: null } };
    expect(postReviewSchema.safeParse(review(viewings.complete, { claims: [claim] })).success).toBe(true);
    expect(postReviewSchema.safeParse(review(viewings.machineTranscript, { claims: [claim] })).success).toBe(false);
    expect(postReviewSchema.safeParse(review(viewings.complete, { claims: [{ ...claim, human_review: { status: "accepted", reviewer: "synthetic-agent", decided_at: "2026-11-08T12:00:00Z" } }] })).success).toBe(false);
  });
});

describe("J20 lifestyle taxonomy", () => {
  const base: Omit<ContextInput, "primary_bucket"> = { secondary_labels: [], excluded_topics: [], educator_or_credentialed: null, selection_reason: "ordinary_recent" };
  it.each(["grwm", "workday", "organization", "travel_purse", "practical_product_use"] as const)("%s is a relevant lifestyle context", (bucket) => {
    expect(classifyContext({ ...base, primary_bucket: bucket }, true)).toEqual({ relevant: true, exclusions: [] });
  });
  it("excludes clinical lectures, IVF/fertility explainers and generic medical education", () => {
    for (const topic of ["clinical_lecture", "ivf_fertility_explainer", "generic_medical_education"] as const)
      expect(classifyContext({ ...base, primary_bucket: "workday", excluded_topics: [topic] }, true)).toEqual({ relevant: false, exclusions: [`EXCLUDED_${topic.toUpperCase()}`] });
    expect(classifyContext({ ...base, primary_bucket: "other" }, true).exclusions).toEqual(["NOT_LIFESTYLE_CONTEXT"]);
    expect(classifyContext({ ...base, primary_bucket: "unknown" }, true).exclusions).toEqual(["CONTEXT_UNKNOWN"]);
  });
  it("educator or credential status adds no fit bonus and does not rescue an excluded topic", () => {
    for (const educator of [true, false, null]) {
      expect(classifyContext({ ...base, primary_bucket: "workday", educator_or_credentialed: educator }, true)).toEqual({ relevant: true, exclusions: [] });
      expect(classifyContext({ ...base, primary_bucket: "workday", excluded_topics: ["clinical_lecture"], educator_or_credentialed: educator }, true).relevant).toBe(false);
    }
  });
});

describe("J20 audience aggregate proof", () => {
  const report: AudienceEvidence = { evidence_id: "synthetic-aud-1", dimension: "country_region", value: [{ bucket: "Region A", share: 0.6 }, { bucket: "Region B", share: 0.4 }],
    source_type: "dated_creator_export", period: { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" }, observed_at: "2026-11-08T12:00:00Z",
    provenance_ref: "synthetic:export-receipt", verified: true,
    limits: "No face-, voice-, name- or health-status inference; public creator location is not audience-share evidence." };
  it("accepts only a dated authorized native report or creator export with provenance", () => {
    expect(audienceProofState(audienceEvidenceSchema.parse(report))).toEqual({ accepted: true, reason: "AUTHORIZED_DATED_AGGREGATE" });
    expect(audienceProofState(audienceEvidenceSchema.parse({ ...report, source_type: "authorized_native_analytics" })).accepted).toBe(true);
    expect(audienceEvidenceSchema.safeParse({ ...report, period: null }).success).toBe(false);
    expect(audienceEvidenceSchema.safeParse({ ...report, provenance_ref: null }).success).toBe(false);
    expect(audienceEvidenceSchema.safeParse({ ...report, source_type: "public_self_description" }).success).toBe(false);
    const unverified = audienceEvidenceSchema.parse({ ...report, verified: false });
    expect(audienceProofState(unverified)).toEqual({ accepted: false, reason: "AUDIENCE_REPORT_UNVERIFIED" });
    expect(audienceProofState(audienceEvidenceSchema.parse({ ...report, source_type: "public_self_description", verified: false })).reason).toBe("PUBLIC_SELF_DESCRIPTION_NOT_AUDIENCE_PROOF");
  });
  it("has no field for inferring audience age, region or health from faces, voices, names, appearance or creator location", () => {
    for (const field of ["inferred_from", "face_estimate", "voice_estimate", "creator_location", "health_status"])
      expect(audienceEvidenceSchema.safeParse({ ...report, [field]: "anything" }).success, field).toBe(false);
    expect(audienceEvidenceSchema.safeParse({ ...report, dimension: "health" }).success).toBe(false);
  });
});

describe("J20 comment samples", () => {
  const sample = review().comments;
  it("declares n, order and time; caps at 20 visible top-level rows; keeps prompted flags", () => {
    expect(commentEvidenceSchema.safeParse(sample).success).toBe(true);
    expect(commentEvidenceSchema.safeParse({ ...sample, declared_n: 3 }).success).toBe(false);
    const rows = Array.from({ length: 21 }, (_, i) => ({ commentId: `synthetic-c${i}`, authorRef: null, creator: false, promotional: false, prompted: false, categories: ["generalReaction"], text: "Nice" }));
    expect(commentEvidenceSchema.safeParse({ ...sample, declared_n: 21, sample: { ...sample.sample, rows } }).success).toBe(false);
    if (sample.sample.status !== "observed") throw new Error("fixture");
    const unflagged = { ...sample.sample, rows: [{ ...sample.sample.rows[1]!, prompted: false }] };
    expect(commentEvidenceSchema.safeParse({ ...sample, declared_n: 1, sample: unflagged }).success).toBe(false);
  });
  it("an unobserved sample carries unknown counts, not zero", () => {
    const missing = { sample: { status: "unavailable", reason: "Synthetic comments disabled." }, declared_n: null, source_ref: "synthetic:comments", visible_author_count: null };
    expect(commentEvidenceSchema.safeParse(missing).success).toBe(true);
    expect(commentEvidenceSchema.safeParse({ ...missing, declared_n: 0 }).success).toBe(false);
    expect(commentEvidenceSchema.safeParse({ ...missing, visible_author_count: 0 }).success).toBe(false);
  });
});

describe("J20 versioned evidence schema", () => {
  it("rejects inferred demographic or health fields on a record and records production choices as production choices", () => {
    const shape = videoEvidenceRecordSchema.innerType().shape;
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(["schema_version", "collector_version", "keys", "brief", "review_policy", "like_gate", "viewing", "features",
      "production_choices", "metrics", "audience", "claims", "comments", "limitations", "next_action"]));
    for (const banned of ["creator_age", "creator_health", "audience_demographics", "purchasing_power", "diagnosis"]) expect(shape).not.toHaveProperty(banned);
  });
});
