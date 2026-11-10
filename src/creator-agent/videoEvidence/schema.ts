import { z } from "zod";
import { commentsSchema, reviewSchema } from "../evidence.ts";
import { opaqueRef, sourceRefSchema, sourceUrlSchema } from "../intake/contract.ts";

/**
 * J20 typed evidence schemas. Normalized Farda fields, not provider API fields. J20 collects and versions evidence;
 * J02 (policy.ts) owns assessment, ratings and arithmetic. Nothing here assigns a score, sends or spends.
 */
export const VIDEO_EVIDENCE_SCHEMA_VERSION = "farda.video-evidence.v1" as const;
export const COLLECTOR_VERSION = "j20-collector.v1" as const;
export const J20_JOB_ID = "J20" as const;
export const J20_JOB_VERSION = "j20.v1" as const;
/** Versioned recent relevant-post policy: strict >200 native likes, 3 posts / 2 dates / 2 action posts, 10-post metadata baseline. */
export const SAMPLING_POLICY_VERSION = "j20-sampling.2026-11-04.v1" as const;
export const TAXONOMY_VERSION = "j20-lifestyle-taxonomy.v1" as const;
export const DEEP_REVIEW_LIKE_THRESHOLD = 200;

/**
 * Owner decision, deliberately without a default. Unset or `creditAsComplete: false`: a sampled-frame review is partial,
 * earns no packet credit, and its frame-only actions never count as meaningful use. Only an explicit policy with frame and
 * span minimums lets sampled frames count as a complete review. Sampled frames are never continuous playback either way.
 */
export const sampledFramePolicySchema = z.discriminatedUnion("creditAsComplete", [
  z.object({ creditAsComplete: z.literal(false) }).strict(),
  z.object({ creditAsComplete: z.literal(true), minFrames: z.number().int().min(2).max(1_000),
    /** (last frame - first frame) / clip duration. */
    minCoverageRatio: z.number().gt(0).max(1) }).strict(),
]);
export type SampledFramePolicy = z.infer<typeof sampledFramePolicySchema>;
/** Collector configuration. `sampledFramePolicy` has no default and stays unset until the owner decides. */
export type VideoEvidenceConfig = { sampledFramePolicy?: SampledFramePolicy };

const ref = opaqueRef;
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const text = z.string().trim().min(1).max(500);
export const instant = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)), "Use a finite source timestamp.");
const count = z.number().int().nonnegative().safe();
const second = z.number().finite().min(0).max(86_400);
const fail = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

export const platformSchema = z.enum(["instagram", "tiktok"]);
export type Platform = z.infer<typeof platformSchema>;
export const sourceRouteSchema = z.enum(["public_native_ui", "permitted_official_api", "authorized_creator_export", "human_supplied_media"]);
export const accessStateSchema = z.enum(["permitted", "loginRequired", "mfaRequired", "permissionDenied", "unavailable", "removed", "changed"]);
export type AccessState = z.infer<typeof accessStateSchema>;

/* ---------- MetricObservation ---------- */

export const missingReasonSchema = z.enum(["hidden", "unavailable", "not_authorized", "unsupported", "stale", "not_collected", "not_applicable"]);
export const metricObservationSchema = z.object({
  platform: platformSchema,
  provider_product: ref,
  metric_key: z.enum(["likes", "views", "comments", "shares", "saves", "followers", "orders", "gmv"]),
  definition_version: ref,
  source_scope: z.enum(["post", "profile", "product", "cohort"]),
  value: z.number().finite().nonnegative().nullable(),
  /** The label exactly as the source displayed it, e.g. "201", "1.2K" or "Hidden". Never normalized away. */
  raw_display: z.string().max(80).nullable(),
  approximate: z.boolean(),
  unit: z.enum(["count", "fraction", "percent", "currency", "duration"]),
  numerator_components: z.array(ref).max(20).nullable(),
  denominator_key: ref.nullable(),
  denominator_value: z.number().finite().positive().nullable(),
  window: z.object({ start: instant.nullable(), end: instant.nullable(), timezone: z.string().min(1).max(64).nullable(), period_or_lifetime: z.enum(["period", "lifetime"]) }).strict(),
  cohort: z.object({ post_ids: z.array(ref).max(100), creator_ids: z.array(ref).max(20), product_ids: z.array(ref).max(100),
    order_ids_or_private_link: ref.nullable(), organic_paid_mixed: z.enum(["organic", "paid", "mixed", "unknown"]), post_age_range: z.string().max(80).nullable() }).strict(),
  refund_basis: z.enum(["included", "excluded", "unknown", "not_applicable"]),
  attribution_rule: ref.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  observed_at: instant,
  source_updated_at: instant.nullable(),
  /** An opaque permission-safe source reference; provider URLs are kept on the record identity, not on each metric. */
  source_url: ref,
  source_type: z.enum(["native_report", "native_public_counter", "authorized_export", "derived", "third_party"]),
  derivation: z.object({ formula: text, input_observation_ids: z.array(ref).min(1).max(20) }).strict().nullable(),
  missing_reason: missingReasonSchema.nullable(),
}).strict().superRefine((m, ctx) => {
  // Missing never becomes zero: a null value needs its reason and a reason forbids a value.
  if ((m.value === null) !== (m.missing_reason !== null)) fail(ctx, ["missing_reason"], "A missing value needs a missing reason, and a known value cannot carry one.");
  if (m.source_type === "derived" && !m.derivation) fail(ctx, ["derivation"], "Derived metrics retain their formula and input observations.");
  if (m.unit === "currency" && m.value !== null && !m.currency) fail(ctx, ["currency"], "Currency values need a currency.");
  if ((m.denominator_key === null) !== (m.denominator_value === null) && m.value !== null) fail(ctx, ["denominator_value"], "A rate retains its denominator key and value together.");
});
export type MetricObservation = z.infer<typeof metricObservationSchema>;

/* ---------- AudienceEvidence ---------- */

export const audienceEvidenceSchema = z.object({
  evidence_id: ref,
  dimension: z.enum(["country_region", "age_band", "language"]),
  /** A provider-supplied aggregate (bucket label to share), never a per-person attribute. */
  value: z.array(z.object({ bucket: z.string().trim().min(1).max(80), share: z.number().min(0).max(1) }).strict()).max(50).nullable(),
  source_type: z.enum(["authorized_native_analytics", "dated_creator_export", "public_self_description"]),
  period: z.object({ start: instant, end: instant }).strict().nullable(),
  observed_at: instant,
  provenance_ref: ref.nullable(),
  verified: z.boolean(),
  limits: z.literal("No face-, voice-, name- or health-status inference; public creator location is not audience-share evidence."),
}).strict().superRefine((a, ctx) => {
  if (a.verified && (a.source_type === "public_self_description" || !a.period || !a.provenance_ref || !a.value))
    fail(ctx, ["verified"], "Only a dated authorized native report or creator export with provenance can be verified aggregate proof.");
  if (a.period && Date.parse(a.period.end) <= Date.parse(a.period.start)) fail(ctx, ["period"], "A report period must end after it starts.");
});
export type AudienceEvidence = z.infer<typeof audienceEvidenceSchema>;

/* ---------- Viewing ---------- */

export const intervalModalitySchema = z.enum(["visual_continuous", "visual_frame", "audio_heard", "audio_machine_transcript", "native_caption"]);
export const observedIntervalSchema = z.object({ start_seconds: second, end_seconds: second, modality: intervalModalitySchema, evidence_ref: ref }).strict()
  .superRefine((i, ctx) => {
    // A sampled frame is a point. Every other modality is a real range.
    if (i.modality === "visual_frame" ? i.end_seconds !== i.start_seconds : i.end_seconds <= i.start_seconds)
      fail(ctx, ["end_seconds"], i.modality === "visual_frame" ? "A sampled frame is a single point, not a watched range." : "An observed range must end after it starts.");
  });
export type ObservedInterval = z.infer<typeof observedIntervalSchema>;

export const viewingStatusSchema = z.enum(["not_opened", "blocked", "unavailable", "metadata_only", "sampled_playback", "partial_playback", "full_visual_only", "complete_audio_visual"]);
export type ViewingStatus = z.infer<typeof viewingStatusSchema>;
export const viewingMethodSchema = z.enum(["continuous_native_playback", "approved_media_review", "sampled_frames", "caption_only", "none"]);
export const audioStateSchema = z.enum(["heard", "caption_only", "muted", "unavailable", "unknown"]);
/** How audio was assessed. Reuses the J02 review vocabulary: a machine transcript ("asr") is never heard audio. */
export const audioMethodSchema = reviewSchema.innerType().shape.audioMethod;

/** What the collector/reviewer reports. Status and coverage are derived by rules.ts, never supplied. */
export const viewingInputSchema = z.object({
  method: viewingMethodSchema,
  duration_seconds: z.number().finite().positive().max(86_400).nullable(),
  observed_intervals: z.array(observedIntervalSchema).max(1_000),
  playback_elapsed_seconds: z.number().finite().nonnegative().nullable(),
  audio_state: audioStateSchema,
  audio_method: audioMethodSchema,
  interruption_reason: z.string().trim().min(1).max(200).nullable(),
  reviewer: ref,
  reviewed_at: instant,
}).strict().superRefine((v, ctx) => {
  const has = (m: z.infer<typeof intervalModalitySchema>) => v.observed_intervals.some((i) => i.modality === m);
  if (v.method === "sampled_frames" && has("visual_continuous")) fail(ctx, ["observed_intervals"], "Sampled frames cannot be recorded as continuous playback.");
  if ((v.method === "continuous_native_playback" || v.method === "approved_media_review") && has("visual_frame"))
    fail(ctx, ["observed_intervals"], "Record continuous ranges separately from sampled frames.");
  if ((v.method === "caption_only" || v.method === "none") && (has("visual_continuous") || has("visual_frame")))
    fail(ctx, ["observed_intervals"], "A caption-only or unopened review carries no visual observation.");
  if (has("audio_heard") !== (v.audio_method === "heard")) fail(ctx, ["audio_method"], "Heard ranges require an actual heard-audio assessment, and vice versa.");
  if (v.audio_state === "heard" && v.audio_method !== "heard") fail(ctx, ["audio_state"], "A machine transcript, caption or unassessed audio is not heard audio.");
  if (v.audio_method === "unassessed" && v.audio_state !== "unknown" && v.audio_state !== "muted" && v.audio_state !== "unavailable")
    fail(ctx, ["audio_state"], "Unassessed audio stays unknown.");
  if (has("audio_machine_transcript") && v.audio_method !== "asr") fail(ctx, ["audio_method"], "Transcript ranges must be labelled as machine transcription.");
  if (v.duration_seconds !== null && v.observed_intervals.some((i) => i.end_seconds > v.duration_seconds! + 0.5))
    fail(ctx, ["observed_intervals"], "Observed ranges cannot extend past the clip.");
});
export type ViewingInput = z.infer<typeof viewingInputSchema>;
export const viewingSchema = viewingInputSchema.innerType().extend({
  status: viewingStatusSchema,
  visual_coverage_percent: z.number().min(0).max(100).nullable(),
  heard_coverage_percent: z.number().min(0).max(100).nullable(),
  sampled_point_count: count,
}).strict();
export type Viewing = z.infer<typeof viewingSchema>;

/* ---------- Observations, claims, production choices ---------- */

export const featureKeySchema = z.enum(["hook", "handling_operation_use", "explanation", "visible_outcome", "cta", "claim"]);
export const featureSchema = z.object({
  feature_key: featureKeySchema,
  status: z.enum(["observed", "not_observed", "unknown", "not_applicable"]),
  /** Where the fact came from. Narration says something happened; only "shown" shows it. */
  channel: z.enum(["shown", "narrated", "caption_text"]).nullable(),
  ordinal_rating: z.null(),
  evidence_ref: ref.nullable(),
  video_timestamp: second.nullable(),
  exact_observation: text.nullable(),
  /** Reviewer interpretation kept apart from the observation; never mixed into exact_observation. */
  interpretation: z.object({ text, reviewer: ref }).strict().nullable(),
  brief_match: z.enum(["matched", "not_matched", "unknown"]).nullable(),
  /** Visible outcome causality stays unresolved unless separately evidenced. */
  causality: z.enum(["unresolved", "not_applicable"]),
}).strict().superRefine((f, ctx) => {
  if (f.status === "observed" && (f.video_timestamp === null || !f.exact_observation || !f.evidence_ref || !f.channel))
    fail(ctx, ["status"], "An observed feature needs its timestamp, exact observation, channel and evidence reference.");
  if (f.status !== "observed" && (f.exact_observation || f.channel)) fail(ctx, ["status"], "Only an observed feature carries an observation.");
  if (f.feature_key === "handling_operation_use" && f.status === "observed" && f.brief_match === null) fail(ctx, ["brief_match"], "Apply the assigned brief to observed handling or use.");
  if (f.feature_key !== "handling_operation_use" && f.brief_match !== null) fail(ctx, ["brief_match"], "Brief matching applies to handling, operation or use.");
  if (f.feature_key === "visible_outcome" && f.causality !== "unresolved") fail(ctx, ["causality"], "Outcome causality stays unresolved.");
});
export type Feature = z.infer<typeof featureSchema>;

/** Minimal claim/topic observation. No diagnosis, medication, personal health or viewer-health field exists. */
export const claimSchema = z.object({
  claim_id: ref,
  topic: z.enum(["compatibility", "medical", "product_function", "outcome", "other"]),
  video_timestamp: second,
  channel: z.enum(["shown", "narrated", "caption_text"]),
  method: z.enum(["heard", "asr", "nativeCaptions", "visual"]),
  summary: text,
  human_review: z.object({ status: z.enum(["pending", "accepted", "rejected"]), reviewer: ref.nullable(), decided_at: instant.nullable() }).strict(),
}).strict().superRefine((c, ctx) => {
  if ((c.human_review.status === "pending") !== (c.human_review.reviewer === null) || (c.human_review.reviewer === null) !== (c.human_review.decided_at === null))
    fail(ctx, ["human_review"], "Only a recorded human reviewer decision resolves a claim.");
});
export type Claim = z.infer<typeof claimSchema>;

/** Styling, framing and legibility are production choices for the brief, never creator or audience inference. */
export const productionChoiceSchema = z.object({
  key: z.enum(["styling", "framing", "legibility", "lighting", "pacing", "on_screen_text"]),
  video_timestamp: second.nullable(),
  observation: text,
  evidence_ref: ref,
}).strict();

/** Up to 20 visible top-level comments. Reuses the J02 comment sample and its categories. */
export const commentEvidenceSchema = z.object({
  sample: commentsSchema,
  declared_n: count.max(20).nullable(),
  source_ref: ref,
  visible_author_count: count.nullable(),
}).strict().superRefine((c, ctx) => {
  if (c.sample.status === "observed" && c.declared_n !== c.sample.rows.length) fail(ctx, ["declared_n"], "The declared n is the number of inspected rows.");
  if (c.sample.status !== "observed" && (c.declared_n !== null || c.visible_author_count !== null)) fail(ctx, ["declared_n"], "An unobserved sample has unknown counts, not zero.");
});
export type CommentEvidence = z.infer<typeof commentEvidenceSchema>;

/* ---------- Sampling, taxonomy, shoppable context ---------- */

export const lifestyleBucketSchema = z.enum(["grwm", "workday", "organization", "travel_purse", "practical_product_use", "other", "unknown"]);
export const excludedTopicSchema = z.enum(["clinical_lecture", "ivf_fertility_explainer", "generic_medical_education"]);
export const contextInputSchema = z.object({
  primary_bucket: lifestyleBucketSchema,
  secondary_labels: z.array(z.string().trim().min(1).max(60)).max(10),
  excluded_topics: z.array(excludedTopicSchema).max(3),
  /** Recorded only to prove it adds nothing: educator or credential status never changes fit. */
  educator_or_credentialed: z.boolean().nullable(),
  selection_reason: z.enum(["ordinary_recent", "stronger_recent", "sponsored", "organic", "deliberate_counterexample"]),
}).strict();
export type ContextInput = z.infer<typeof contextInputSchema>;

export const shoppableContextSchema = z.object({
  status: z.enum(["observed", "unknown", "not_applicable"]),
  product_ref: ref.nullable(),
  anchor_evidence_ref: ref.nullable(),
  observed_at: instant.nullable(),
}).strict().superRefine((s, ctx) => {
  // A generic URL, account statistics or a detached listing does not prove this post is shoppable.
  if ((s.status === "observed") !== Boolean(s.anchor_evidence_ref && s.observed_at)) fail(ctx, ["anchor_evidence_ref"], "Only an observed native post-to-product link proves a shoppable post.");
});

/* ---------- Source reader contract ---------- */

/** Step 1: what an injected source reader returns for one post before any playback. Validated before anything is stored. */
export const postMetadataSchema = z.object({
  platform: platformSchema,
  creator_source_id: ref,
  post_source_id: ref.nullable(),
  canonical_url: sourceUrlSchema,
  route: sourceRouteSchema,
  provider_account_scope: ref.nullable(),
  permission_ref: ref,
  permission_checked_at: instant,
  published_at: instant.nullable(),
  retrieved_at: instant,
  source_content_fingerprint: ref.nullable(),
  pinned: z.boolean().nullable(),
  paid: z.enum(["yes", "no", "unknown"]),
  relevant: z.boolean(),
  context: contextInputSchema,
  likes: metricObservationSchema,
  metrics: z.array(metricObservationSchema).max(20),
  shoppable_context: shoppableContextSchema,
  evidence_refs: z.array(ref).max(50),
}).strict().superRefine((o, ctx) => {
  if (o.likes.metric_key !== "likes" || o.likes.source_scope !== "post") fail(ctx, ["likes"], "The deep-review gate reads the post's like counter.");
  if (o.metrics.some((m) => m.metric_key === "likes")) fail(ctx, ["metrics"], "Record likes once, in the gate field.");
  if (o.likes.platform !== o.platform || o.metrics.some((m) => m.platform !== o.platform)) fail(ctx, ["metrics"], "Metrics must come from this post's platform.");
});
export type PostMetadata = z.infer<typeof postMetadataSchema>;

/** Step 2, only for a post that passed the strict native-like gate: the permitted playback review. */
export const postReviewSchema = z.object({
  viewing: viewingInputSchema,
  features: z.array(featureSchema).max(100),
  claims: z.array(claimSchema).max(50),
  production_choices: z.array(productionChoiceSchema).max(30),
  comments: commentEvidenceSchema,
  audience: z.array(audienceEvidenceSchema).max(20),
}).strict().superRefine((r, ctx) => {
  if (new Set(r.claims.map((c) => c.claim_id)).size !== r.claims.length) fail(ctx, ["claims"], "Claim IDs must be unique.");
  for (const [index, claim] of r.claims.entries()) {
    if ((claim.method === "heard" && r.viewing.audio_method !== "heard") || (claim.method === "asr" && r.viewing.audio_method !== "asr"))
      fail(ctx, ["claims", index, "method"], "A claim's method must match how the audio was actually assessed.");
    if (claim.human_review.status !== "pending") fail(ctx, ["claims", index, "human_review"], "A collector cannot resolve a claim; only a human reviewer can.");
  }
});
export type PostReview = z.infer<typeof postReviewSchema>;

/** A Farda-authored free-text field withheld by the inference screen, with its refusal codes. The text itself is not kept. */
export const quarantineSchema = z.array(z.object({ field: z.string().min(1).max(120), reason_codes: z.array(reason).min(1).max(10),
  /** A human reviewer's acknowledgment; the withheld text is never restored. */
  reviewed: z.object({ reviewer: ref, decided_at: instant }).strict().nullable() }).strict()).max(100);
export type Quarantine = z.infer<typeof quarantineSchema>;

const failure = <S extends "loginRequired" | "mfaRequired" | "permissionDenied" | "unavailable">(state: S) =>
  z.object({ state: z.literal(state), source_ref: ref, observed_at: instant, reason_code: reason }).strict();
export const sourceReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("observed"), observation: postMetadataSchema }).strict(),
  /** A removed or changed post is an observation about the post itself and becomes a new evidence version. */
  z.object({ state: z.literal("removed"), source_ref: ref, observed_at: instant }).strict(),
  z.object({ state: z.literal("changed"), source_ref: ref, observed_at: instant, source_content_fingerprint: ref.nullable(), post_source_id: ref.nullable() }).strict(),
  /** Access failures are recorded beside the evidence; they never replace or invent an observation. */
  failure("loginRequired"), failure("mfaRequired"), failure("permissionDenied"), failure("unavailable"),
]);
export type SourceRead = z.infer<typeof sourceReadSchema>;
export const reviewReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("observed"), review: postReviewSchema }).strict(),
  sourceReadSchema.options[1], sourceReadSchema.options[2], failure("loginRequired"), failure("mfaRequired"), failure("permissionDenied"), failure("unavailable"),
]);
export type ReviewRead = z.infer<typeof reviewReadSchema>;
export type AccessFailure = Extract<SourceRead, { state: "loginRequired" | "mfaRequired" | "permissionDenied" | "unavailable" }>;

/* ---------- VideoEvidenceRecord ---------- */

export const nextActionSchema = z.enum(["review_complete", "needs_playback", "needs_metric_proof", "needs_audience_proof", "needs_claim_review", "source_unavailable"]);
export type NextAction = z.infer<typeof nextActionSchema>;
export const likeGateSchema = z.object({
  state: z.enum(["pass", "fail", "pending"]),
  raw_label: z.string().max(80).nullable(),
  parsed: z.enum(["exact", "rounded", "hidden", "absent", "ambiguous", "third_party"]),
  value: count.nullable(),
  source_type: metricObservationSchema.innerType().shape.source_type,
  observed_at: instant,
  reason_code: reason,
}).strict();
export type LikeGate = z.infer<typeof likeGateSchema>;

export const videoEvidenceRecordSchema = z.object({
  schema_version: z.literal(VIDEO_EVIDENCE_SCHEMA_VERSION),
  collector_version: z.literal(COLLECTOR_VERSION),
  keys: z.object({
    platform: platformSchema, creator_source_id: ref, post_source_id: ref.nullable(),
    /** Native ID when present, otherwise a controlled URL fingerprint. */
    canonical_post_key: ref, canonical_url: sourceUrlSchema, evidence_version: z.number().int().positive(), review_job_id: ref,
  }).strict(),
  brief: z.object({ ref, version: ref }).strict(),
  review_policy: z.object({ sampling_policy_version: ref, taxonomy_version: ref, policy_version: ref,
    /** The sampled-frame decision this version was built under; null while the owner decision is unset. */
    sampled_frame_policy: sampledFramePolicySchema.nullable() }).strict(),
  source: z.object({
    route: sourceRouteSchema, provider_account_scope: ref.nullable(), permission_ref: ref, permission_checked_at: instant,
    published_at: instant.nullable(), retrieved_at: instant, source_content_fingerprint: ref.nullable(),
    access_state: z.enum(["permitted", "removed", "changed"]), deleted_or_changed: z.boolean(), evidence_refs: z.array(ref).max(50),
  }).strict(),
  sampling: z.object({
    taxonomy_version: ref, primary_bucket: lifestyleBucketSchema, secondary_labels: z.array(z.string()).max(10),
    excluded_topics: z.array(excludedTopicSchema).max(3), relevant: z.boolean(), selection_reason: contextInputSchema.shape.selection_reason,
    pinned: z.boolean().nullable(), paid: z.enum(["yes", "no", "unknown"]), post_age_days: z.number().nonnegative().nullable(),
  }).strict(),
  like_gate: likeGateSchema,
  deep_review: z.object({ eligible: z.boolean(), credit: z.boolean(), metadata_only: z.boolean(), exclusion_reasons: z.array(reason).max(10) }).strict(),
  viewing: viewingSchema.nullable(),
  features: z.array(featureSchema).max(100),
  production_choices: z.array(productionChoiceSchema).max(30),
  metrics: z.array(metricObservationSchema).max(21),
  audience: z.array(audienceEvidenceSchema).max(20),
  claims: z.array(claimSchema).max(50),
  comments: commentEvidenceSchema,
  shoppable_context: shoppableContextSchema,
  limitations: z.array(reason).max(30),
  /** Fields dropped at intake by the inference screen. Stored versions are never re-screened on read. */
  quarantined: quarantineSchema,
  next_action: nextActionSchema,
  prior_version: z.number().int().positive().nullable(),
}).strict().superRefine((r, ctx) => {
  if (r.deep_review.credit && (!r.deep_review.eligible || r.like_gate.state !== "pass")) fail(ctx, ["deep_review"], "Deep-review credit requires a passed native-like gate.");
  if (r.deep_review.metadata_only && r.deep_review.credit) fail(ctx, ["deep_review"], "Metadata-only posts receive no deep-review credit.");
});
export type VideoEvidenceRecord = z.infer<typeof videoEvidenceRecordSchema>;

/* ---------- J20 job input/output ---------- */

export const actorSchema = z.object({ id: ref, role: z.enum(["agent", "reviewer", "owner"]) }).strict();
export const j20InputSchema = z.object({
  jobId: z.literal(J20_JOB_ID), jobVersion: z.literal(J20_JOB_VERSION),
  mode: z.enum(["observe", "reconcile"]),
  actor: actorSchema, accountRef: sourceRefSchema, policyVersion: ref, inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  idempotencyKey: ref, correlationId: ref, requestedAt: instant, deadline: instant.nullable(),
  creatorRef: sourceRefSchema, profileRef: sourceRefSchema,
  /** Candidate posts, including lower-like recent posts for the reach baseline. Only strict >200 posts get deep review. */
  postRefs: z.array(sourceRefSchema).min(1).max(100),
  briefRef: z.object({ ref, version: ref }).strict(),
  samplingPolicyVersion: z.literal(SAMPLING_POLICY_VERSION),
  researchGateRef: ref,
  taxonomyVersion: z.literal(TAXONOMY_VERSION),
  sourcePermissionRefs: z.array(ref).min(1).max(20),
  reviewRequirements: z.object({ audienceProofRequired: z.boolean(), packetRequired: z.boolean() }).strict(),
  priorEvidenceRefs: z.array(ref).max(100),
}).strict().superRefine((input, ctx) => {
  const keys = input.postRefs.map((p) => JSON.stringify([p.source, p.sourceId ?? p.url]));
  if (new Set(keys).size !== keys.length) fail(ctx, ["postRefs"], "Post references must be unique.");
  if (input.postRefs.some((p) => !platformSchema.safeParse(p.source).success || (!p.sourceId && !p.url)))
    fail(ctx, ["postRefs"], "Each post names its network and a native ID or canonical URL.");
});
export type J20Input = z.infer<typeof j20InputSchema>;

export const j20OutputSchema = z.object({
  schemaVersion: z.literal(VIDEO_EVIDENCE_SCHEMA_VERSION),
  collectorVersion: z.literal(COLLECTOR_VERSION),
  evidenceRecordRefs: z.array(ref),
  viewingCoverage: z.record(z.string(), z.unknown()),
  contentMixAssessment: z.record(z.string(), z.unknown()),
  metricObservations: z.array(metricObservationSchema),
  audienceEvidence: z.array(audienceEvidenceSchema),
  claimsReview: z.array(z.object({ evidenceRef: ref, claim: claimSchema }).strict()),
  limitations: z.array(reason),
  nextAction: z.enum(["reviewComplete", "needsPlayback", "needsMetricProof", "needsAudienceProof", "needsClaimReview", "sourceUnavailable"]),
}).strict();
export type J20Output = z.infer<typeof j20OutputSchema>;
