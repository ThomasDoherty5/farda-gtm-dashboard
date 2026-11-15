import { z } from "zod";
import { accessObservation } from "./evidenceReviewContract.ts";

/** Public wire schemas and pure summaries. Safe to import in the browser; no source access happens here. */
const id = z.string().trim().min(1).max(240);
const reason = z.string().trim().min(1).max(1_000);
const sourceRef = z.string().trim().min(1).max(1_000);
const instant = z.string().datetime({ offset: true }).refine(t => Number.isFinite(Date.parse(t)), "Use a finite source timestamp.");
const count = z.number().int().nonnegative().safe();
const seconds = z.number().finite().nonnegative();
const rating = z.number().int().min(0).max(5).nullable();
/** The label exactly as the source displayed it ("201", "1,204", "1.2K", "Hidden"). Never normalized away. */
const rawLabel = z.string().trim().min(1).max(80);
const label = z.string().trim().min(1).max(60);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

/* J20 direct-video evidence versions. A packet that carries `collection` was written by the J20 collector under these versions. */
export const VIDEO_EVIDENCE_SCHEMA_VERSION = "farda.video-evidence.v1" as const;
/**
 * The owner-approved "Farda — approved creator scorecard policy" revision of 2026-11-04 (the same revision as POLICY_VERSION):
 * strict >200 native likes, the 3-post / 2-date packet with 2 action posts, the 10 recent relevant unpinned posts and up to
 * 20 visible top-level comments. J20 adds no sampling rule of its own.
 */
export const J20_SAMPLING_POLICY_VERSION = "approved-creator-scorecard-policy.2026-11-04" as const;
/**
 * Label for the lifestyle vocabulary and the three content exclusions in the J20 acceptance criteria. Only those exclusions
 * gate relevance; the bucket labels are descriptive. NEEDS-OWNER: confirm the vocabulary and its version label.
 */
export const J20_TAXONOMY_VERSION = "j20-lifestyle-taxonomy.v1" as const;
const EXACT_LABEL = /^\d{1,3}(?:,\d{3})+$|^\d+$/;
const ROUNDED_LABEL = /^\d+(?:[.,]\d+)?\s*[KkMmBb]$/;
/** An exact native count is a plain or comma-grouped integer equal to the stored value. Anything else is not exact. */
export const isExactCountLabel = (raw: string, value: number) => EXACT_LABEL.test(raw.trim()) && Number(raw.trim().replace(/,/g, "")) === value;
export const isRoundedCountLabel = (raw: string) => ROUNDED_LABEL.test(raw.trim());

export const nativeLikesSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: count, exact: z.boolean(), sourceRef, rawLabel: rawLabel.optional() }).strict(),
  z.object({ status: z.literal("unknown"), reason, rawLabel: rawLabel.optional() }).strict(),
  z.object({ status: z.literal("unavailable"), reason, rawLabel: rawLabel.optional() }).strict(),
]).superRefine((likes, ctx) => {
  // A rounded or mismatched display label can never be stored as an exact native count.
  if (likes.status === "known" && likes.rawLabel !== undefined && likes.exact && !isExactCountLabel(likes.rawLabel, likes.value))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exact"], message: "An exact native count must match its raw source label." });
});
export type NativeLikes = z.infer<typeof nativeLikesSchema>;

const viewsSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: count, definition: reason, window: reason }).strict(),
  z.object({ status: z.literal("unknown"), reason }).strict(),
  z.object({ status: z.literal("unavailable"), reason }).strict(),
]);

export const commentCategorySchema = z.enum([
  "generalReaction", "routineApplication", "productUnderstanding", "practicalObjection",
  "purchaseEvaluation", "promptedKeyword", "selfReportedOwnership",
]);
export type CommentCategory = z.infer<typeof commentCategorySchema>;

const commentRowSchema = z.object({
  commentId: id,
  /** An opaque/de-identified author reference for deduplication, never a health-profile inference. */
  authorRef: id.nullable(),
  creator: z.boolean(),
  promotional: z.boolean(),
  prompted: z.boolean(),
  categories: z.array(commentCategorySchema).min(1).max(7),
  text: z.string().trim().min(1).max(2_000),
}).strict().superRefine((row, ctx) => {
  if (new Set(row.categories).size !== row.categories.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["categories"], message: "Category tags must be unique." });
  if (row.categories.includes("promptedKeyword") && !row.prompted)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompted"], message: "A prompted-keyword reply must retain its prompted flag." });
});

export const commentsSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    ordering: reason,
    observedAt: instant,
    rows: z.array(commentRowSchema).max(20),
  }).strict(),
  z.object({ status: z.literal("unknown"), reason }).strict(),
  z.object({ status: z.literal("unavailable"), reason }).strict(),
]).superRefine((sample, ctx) => {
  if (sample.status === "observed" && new Set(sample.rows.map((row) => row.commentId)).size !== sample.rows.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows"], message: "Comment IDs must be unique within the sample." });
});
export type CommentSample = z.infer<typeof commentsSchema>;

const intervalSchema = z.object({ startSec: seconds, endSec: seconds }).strict()
  .refine((interval) => interval.endSec > interval.startSec, { path: ["endSec"], message: "An interval must end after it starts." });

/** What a shown, timestamped observation is. Narration and reviewer interpretation are recorded elsewhere, never here. */
export const actionKindSchema = z.enum(["hook", "handlingOperationUse", "explanation", "visibleOutcome", "cta"]);
/** Claim topics that need a person: compatibility, medical and outcome claims take the reviewer exception path. */
export const claimTopicSchema = z.enum(["compatibility", "medical", "productFunction", "outcome", "other"]);
export const HUMAN_REVIEW_CLAIM_TOPICS: readonly z.infer<typeof claimTopicSchema>[] = ["compatibility", "medical", "outcome", "other"];
const HEALTH_OR_OUTCOME_WORDING = /\b(?:cur(?:e|ed|es|ing)|heal(?:s|ed|ing)?|treat(?:s|ed|ing|ment)?|diagnos\w*|symptom\w*|disease\w*|condition\w*|disorder\w*|pregnan\w*|fertil\w*|ivf|endometriosis|diabet\w*|insulin|medicat\w*|medicine\w*|prescri\w*|doctor\w*|clinical\w*|therap\w*|pain|safe (?:for|while|during)|side effects?|dose|dosage|injection\w*|vial\w*|refrigerat\w*|weight loss|glp-?1)\b/i;
/**
 * A claim a person must review: a compatibility, medical, outcome or uncategorized topic, or any claim worded about health,
 * medication, treatment or outcomes whatever its topic. The agent never resolves these.
 */
export const claimNeedsPerson = (claim: { text: string; topic?: z.infer<typeof claimTopicSchema> }) =>
  claim.topic === undefined || HUMAN_REVIEW_CLAIM_TOPICS.includes(claim.topic) || HEALTH_OR_OUTCOME_WORDING.test(claim.text);
const spokenMethod = z.enum(["heard", "asr", "nativeCaptions"]);
/**
 * Descriptive only: the edge allowance `reviewCoverage` uses to call a continuous review full. It gates nothing.
 * NEEDS-OWNER: an approved tolerance, if full-clip coverage is ever required.
 */
export const COVERAGE_EDGE_TOLERANCE_SEC = 0.5;

type Span = { startSec: number; endSec: number };
/** Merged, sorted ranges. Overlapping or repeated ranges never add coverage. */
export function intervalUnion(spans: readonly Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.startSec - b.startSec)) {
    const last = merged.at(-1);
    if (last && span.startSec <= last.endSec) last.endSec = Math.max(last.endSec, span.endSec);
    else merged.push({ startSec: span.startSec, endSec: span.endSec });
  }
  return merged;
}
const coveredSeconds = (spans: readonly Span[]) => intervalUnion(spans).reduce((sum, s) => sum + s.endSec - s.startSec, 0);
/** One merged range from the first to the last frame of a known clip. Elapsed player time is never consulted. */
export const coversWholeClip = (spans: readonly Span[], durationSec: number | null | undefined) => {
  if (durationSec === null || durationSec === undefined) return false;
  const merged = intervalUnion(spans);
  return merged.length === 1 && merged[0]!.startSec <= COVERAGE_EDGE_TOLERANCE_SEC && merged[0]!.endSec >= durationSec - COVERAGE_EDGE_TOLERANCE_SEC;
};

export const reviewSchema = z.object({
  status: z.enum(["complete", "partial", "blocked", "unassessed"]),
  /** `captionOnly`: only caption text was read. It is never watched footage and never earns visual coverage. */
  visualMethod: z.enum(["continuous", "sampledFrames", "captionOnly", "unassessed"]),
  /** `muted`: footage was watched with the sound off. It is not heard audio and never earns audio coverage. */
  audioMethod: z.enum(["heard", "asr", "nativeCaptions", "silent", "muted", "unassessed"]),
  reviewerRef: id.optional(),
  reviewedAt: instant.refine(t => Number.isFinite(Date.parse(t))).optional(),
  sampledPoints: z.array(seconds).max(5_000),
  watchedIntervals: z.array(intervalSchema).max(500),
  heardIntervals: z.array(intervalSchema).max(500).optional(),
  observedActions: z.array(z.object({ atSec: seconds, action: reason, meaningfulUse: z.boolean(), kind: actionKindSchema.optional() }).strict()).max(500),
  claims: z.array(z.object({ atSec: seconds, text: reason, method: spokenMethod, topic: claimTopicSchema.optional() }).strict()).max(500),
  inferences: z.array(reason).max(100),
  sourceRef: sourceRef.nullable(),
  /* J20 playback facts. Absent on reviews saved before J20; when present, full review is checked against observed ranges. */
  durationSeconds: z.number().finite().positive().max(86_400).nullable().optional(),
  /** Player time only. It is retained for audit and never counts as observed coverage. */
  playbackElapsedSeconds: seconds.max(86_400).nullable().optional(),
  interruption: z.object({ atSec: seconds, reason }).strict().nullable().optional(),
  /** What the creator said or captioned. Narrating an action never makes it a shown action. */
  narration: z.array(z.object({ atSec: seconds, text: reason, method: spokenMethod, about: z.enum(["action", "outcome", "other"]) }).strict()).max(500).optional(),
}).strict().superRefine((review, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (new Set(review.sampledPoints).size !== review.sampledPoints.length) fail("sampledPoints", "Sampled points must be unique.");
  if (review.visualMethod === "sampledFrames" && review.watchedIntervals.length)
    fail("watchedIntervals", "Sampled frame points cannot be represented as continuously watched intervals.");
  if (review.heardIntervals?.length && review.audioMethod !== "heard")
    fail("heardIntervals", "Heard intervals require an actual heard-audio review.");
  if (review.visualMethod === "continuous" && review.sampledPoints.length)
    fail("sampledPoints", "Record the continuous method's watched intervals separately from sampled frames.");
  if ((review.visualMethod === "unassessed" || review.visualMethod === "captionOnly") && (review.sampledPoints.length || review.watchedIntervals.length || review.observedActions.length))
    fail("visualMethod", "Unassessed visuals or caption text cannot carry observed visual actions or coverage.");
  if (review.visualMethod === "captionOnly" && !["nativeCaptions", "unassessed"].includes(review.audioMethod))
    fail("audioMethod", "A caption-only review did not play the audio.");
  if (review.status === "complete") {
    if (!review.sourceRef) fail("sourceRef", "A completed review needs its source review receipt.");
    if (review.visualMethod === "unassessed" || review.visualMethod === "captionOnly") fail("visualMethod", "Audio, captions or a saved draft alone cannot complete a visual review.");
    if (review.visualMethod === "sampledFrames" && !review.sampledPoints.length) fail("sampledPoints", "Record the actual sampled points.");
    // Completion keeps main's rule: actual watched intervals or sampled points plus a receipt. Elapsed player time is never an
    // interval, so it cannot complete a review alone. NEEDS-OWNER: whether "complete" must also cover the whole clip.
    if (review.visualMethod === "continuous" && !review.watchedIntervals.length) fail("watchedIntervals", "Record the actual watched intervals.");
  }
  if (review.status === "unassessed" && (review.visualMethod !== "unassessed" || review.audioMethod !== "unassessed" || review.claims.length || review.narration?.length))
    fail("status", "Assessed material must be labeled partial rather than unassessed.");
  for (const [index, claim] of review.claims.entries()) {
    if ((claim.method === "heard" && review.audioMethod !== "heard") || (claim.method === "asr" && review.audioMethod !== "asr"))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["claims", index, "method"], message: "The claim's source must match the declared audio assessment method." });
  }
  for (const [index, line] of (review.narration ?? []).entries()) {
    if ((line.method === "heard" && review.audioMethod !== "heard") || (line.method === "asr" && review.audioMethod !== "asr"))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["narration", index, "method"], message: "Narration must come from the declared audio assessment method." });
  }
  for (const [index, action] of review.observedActions.entries()) {
    if (action.kind && action.kind !== "handlingOperationUse" && action.meaningfulUse)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observedActions", index, "meaningfulUse"], message: "Only shown handling, operation or use can count as brief-matched use." });
  }
  const duration = review.durationSeconds ?? null;
  if (duration !== null) {
    // A timestamp after the end of a clip of known length is impossible, not a policy judgement.
    const past = (at: number) => at > duration;
    if ([...review.watchedIntervals, ...(review.heardIntervals ?? [])].some(span => past(span.endSec)) || review.sampledPoints.some(past) ||
        [...review.observedActions, ...review.claims, ...(review.narration ?? [])].some(item => past(item.atSec)) || (review.interruption && past(review.interruption.atSec)))
      fail("durationSeconds", "Observed ranges and timestamps cannot extend past the clip.");
  }
});
export type EvidenceReview = z.infer<typeof reviewSchema>;

export const viewingStatusSchema = z.enum(["completeAudioVisual", "fullVisualOnly", "partialPlayback", "sampledFrames", "captionOnly",
  "interrupted", "blocked", "notOpened", "durationUnknown"]);
export const audioCoverageSchema = z.enum(["heard", "machineTranscript", "captionsOnly", "silentClip", "muted", "unassessed"]);
const audioCoverageOf = { heard: "heard", asr: "machineTranscript", nativeCaptions: "captionsOnly", silent: "silentClip", muted: "muted", unassessed: "unassessed" } as const;
/**
 * Distinct review status and modality coverage derived only from observed ranges and frames. Player time, muted playback and
 * caption text never earn coverage. `durationUnknown` keeps pre-J20 reviews that never recorded a clip length distinct.
 */
export function reviewCoverage(review: EvidenceReview) {
  const duration = review.durationSeconds ?? null;
  const visualSeconds = review.visualMethod === "continuous" ? coveredSeconds(review.watchedIntervals) : 0;
  const heardSeconds = review.audioMethod === "heard" ? coveredSeconds(review.heardIntervals ?? []) : 0;
  const fullVisual = review.visualMethod === "continuous" && coversWholeClip(review.watchedIntervals, duration);
  const status: z.infer<typeof viewingStatusSchema> = review.status === "blocked" ? "blocked"
    : review.visualMethod === "captionOnly" ? "captionOnly"
      : review.visualMethod === "unassessed" ? "notOpened"
        : review.interruption ? "interrupted"
          : review.visualMethod === "sampledFrames" ? "sampledFrames"
            : duration === null ? "durationUnknown"
              : !fullVisual ? "partialPlayback"
                : review.audioMethod === "heard" && coversWholeClip(review.heardIntervals ?? [], duration) ? "completeAudioVisual" : "fullVisualOnly";
  const pct = (value: number) => duration === null ? null : Math.min(100, Math.round(value / duration * 1000) / 10);
  return {
    viewingStatus: status, audioCoverage: audioCoverageOf[review.audioMethod] as z.infer<typeof audioCoverageSchema>,
    visualSeconds, heardSeconds, durationSeconds: duration,
    visualCoveragePct: review.visualMethod === "continuous" ? pct(visualSeconds) : null,
    heardCoveragePct: review.audioMethod === "heard" ? pct(heardSeconds) : null,
    sampledPoints: review.visualMethod === "sampledFrames" ? review.sampledPoints.length : 0,
    playbackElapsedSeconds: review.playbackElapsedSeconds ?? null,
  };
}
export type ReviewCoverage = ReturnType<typeof reviewCoverage>;

const networkSchema = z.enum(["instagram", "tiktok"]);

function isOriginalVideoUrl(value: string, network: z.infer<typeof networkSchema>): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^www\./, "");
  if (network === "tiktok") return (host === "tiktok.com" || host === "m.tiktok.com") && /^\/@[\w.]+\/video\/\d+\/?$/.test(url.pathname);
  return host === "instagram.com" && (/^\/(?:p|reel|reels|tv)\/[\w-]+\/?$/.test(url.pathname) || /^\/[\w.]+\/reels?\/[\w-]+\/?$/.test(url.pathname));
}

/** Stable native asset identity, independent of query strings, aliases and caller-assigned record IDs. */
export function nativePostIdentity(post: { sourceUrl: string; network: "instagram" | "tiktok" }): string {
  // Refinements can still run on a dirty nested URL; preserve Zod validation instead of throwing.
  let path: string;
  try { path = new URL(post.sourceUrl).pathname; } catch { return `${post.network}:invalid:${post.sourceUrl}`; }
  const nativeId = post.network === "tiktok" ? /\/video\/(\d+)/.exec(path)?.[1] : /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(path)?.[1];
  return `${post.network}:${nativeId ?? path}`;
}

/** How the evidence was reached. A route is a permission fact, not a quality rating. */
export const sourceRouteSchema = z.enum(["publicNativeUi", "permittedOfficialApi", "authorizedCreatorExport", "humanSuppliedMedia"]);
/** J20 source provenance for one post. `providerAccountRef` is a scoped opaque alias, never a raw provider account ID. */
export const postSourceSchema = z.object({
  route: sourceRouteSchema,
  providerAccountRef: id.nullable(),
  permissionRef: sourceRef,
  permissionCheckedAt: instant,
  retrievedAt: instant,
  contentFingerprint: id.nullable(),
  /**
   * `changed`: the content fingerprint differs from the prior version. `removed`: the source reports the post gone.
   * `unverified`: a fingerprint is missing on either side, so the footage identity is unknown and nothing is carried.
   */
  change: z.enum(["firstObserved", "unchanged", "changed", "removed", "unverified"]),
  evidenceRefs: z.array(sourceRef).max(50),
}).strict().superRefine((source, ctx) => {
  if (Date.parse(source.permissionCheckedAt) > Date.parse(source.retrievedAt))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["permissionCheckedAt"], message: "Permission must be checked before the source is read." });
});

/** Approved lifestyle taxonomy. Clinical lectures, IVF/fertility explainers and generic medical education are excluded. */
export const lifestyleBucketSchema = z.enum(["grwm", "workday", "organization", "travelPurse", "practicalProductUse", "other", "unknown"]);
export const contentExclusionSchema = z.enum(["clinicalLecture", "ivfFertilityExplainer", "genericMedicalEducation"]);
/** Descriptive lifestyle labels from the J20 acceptance criteria; they record context and gate nothing. */
export const APPROVED_LIFESTYLE_BUCKETS: readonly z.infer<typeof lifestyleBucketSchema>[] = ["grwm", "workday", "organization", "travelPurse", "practicalProductUse"];
export const lifestyleContextSchema = z.object({
  taxonomyVersion: z.literal(J20_TAXONOMY_VERSION),
  primaryBucket: lifestyleBucketSchema,
  secondaryLabels: z.array(label).max(10),
  exclusion: contentExclusionSchema.nullable(),
  /** Recorded only so tests can prove it adds nothing: educator or credential status never changes fit. */
  educatorOrCredentialed: z.boolean().nullable(),
  selectionReason: z.enum(["ordinaryRecent", "strongerRecent", "sponsored", "organic", "deliberateCounterexample"]),
  pinned: z.boolean().nullable(),
  paid: z.enum(["yes", "no", "unknown"]),
}).strict();
export type LifestyleContext = z.infer<typeof lifestyleContextSchema>;

export const metricMissingReasonSchema = z.enum(["hidden", "unavailable", "notAuthorized", "unsupported", "stale", "notCollected", "notApplicable"]);
/** One visible post counter. A hidden or missing value is null with its reason, never zero. Likes stay in the native-like gate. */
export const postMetricSchema = z.object({
  key: z.enum(["views", "comments", "shares", "saves"]),
  value: count.nullable(),
  rawLabel: rawLabel.nullable(),
  approximate: z.boolean(),
  unit: z.literal("count"),
  /** The source's own definition and version, e.g. "native video plays v1". */
  definition: reason,
  window: reason,
  /** Snapshot time of this counter. */
  observedAt: instant,
  sourceType: z.enum(["nativePublicCounter", "nativeReport", "authorizedExport"]),
  sourceRef,
  missingReason: metricMissingReasonSchema.nullable(),
}).strict().superRefine((metric, ctx) => {
  if ((metric.value === null) !== (metric.missingReason !== null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["missingReason"], message: "A missing value needs its reason, and a known value cannot carry one." });
  if (metric.value !== null && metric.rawLabel !== null && !metric.approximate && !isExactCountLabel(metric.rawLabel, metric.value))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approximate"], message: "A rounded or mismatched label is approximate." });
  if (metric.approximate && (metric.value === null || metric.rawLabel === null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rawLabel"], message: "An approximate count keeps its raw label." });
});
export type PostMetric = z.infer<typeof postMetricSchema>;

/** Styling, framing and legibility are production choices for the brief, never creator or audience inference. */
export const productionChoiceSchema = z.object({
  key: z.enum(["styling", "framing", "legibility", "lighting", "pacing", "onScreenText"]),
  atSec: seconds.nullable(), observation: reason, evidenceRef: sourceRef,
}).strict();
/** A generic URL, account statistics or a detached listing does not prove this post is shoppable. */
export const shoppableContextSchema = z.object({
  status: z.enum(["observed", "unknown", "notApplicable"]),
  productRef: id.nullable(), anchorEvidenceRef: sourceRef.nullable(), observedAt: instant.nullable(),
}).strict().superRefine((shop, ctx) => {
  if ((shop.status === "observed") !== Boolean(shop.anchorEvidenceRef && shop.observedAt))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["anchorEvidenceRef"], message: "Only an observed native post-to-product link proves a shoppable post." });
});

export const postEvidenceSchema = z.object({
  postId: id,
  canonicalMediaId: id,
  network: networkSchema,
  sourceUrl: z.string().url().max(2_000),
  accessObservation: accessObservation.optional(),
  publishedAt: instant.nullable(),
  observedAt: instant,
  relevant: z.boolean(),
  nativeLikes: nativeLikesSchema,
  review: reviewSchema,
  comments: commentsSchema,
  /* J20 collection fields. Optional so packets saved before J20 still parse unchanged. */
  source: postSourceSchema.optional(),
  context: lifestyleContextSchema.optional(),
  metrics: z.array(postMetricSchema).max(20).optional(),
  productionChoices: z.array(productionChoiceSchema).max(30).optional(),
  shoppableContext: shoppableContextSchema.optional(),
}).strict().superRefine((post, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (!isOriginalVideoUrl(post.sourceUrl, post.network))
    fail("sourceUrl", "Use the original HTTPS Instagram or TikTok video URL for this network, without embedded credentials.");
  // J20-07 acceptance: clinical lectures, IVF/fertility explainers and generic medical education are excluded. Bucket labels are descriptive.
  if (post.context && post.relevant && post.context.exclusion !== null)
    fail("relevant", "A clinical, fertility or medical-education exclusion is never relevant.");
  if (post.metrics && new Set(post.metrics.map(metric => metric.key)).size !== post.metrics.length) fail("metrics", "Record each counter once.");
  if (post.source) {
    // A J20-collected post always states its access, context, counters and playback facts, even when they are unknown.
    if (!post.context || !post.metrics || !post.accessObservation) fail("source", "J20 posts record their context, counters and access observation.");
    if (post.review.durationSeconds === undefined || post.review.playbackElapsedSeconds === undefined || post.review.interruption === undefined || post.review.narration === undefined)
      fail("review", "J20 posts record clip duration, elapsed playback, interruption and narration, even when unknown.");
    // Approved policy: record observed action and narrated claim separately; an explanation never earns credit for an action it does not show.
    if (post.review.observedActions.some(action => action.kind === undefined))
      fail("review", "Each collected shown action states its kind; only shown handling, operation or use can count as brief-matched use.");
    if (post.review.claims.some(claim => claim.topic === undefined)) fail("review", "Each collected claim states its topic so it can reach a person.");
    if (Date.parse(post.source.retrievedAt) > Date.parse(post.observedAt)) fail("observedAt", "A post cannot be observed before it was retrieved.");
    if ((post.source.change === "removed") !== (post.accessObservation?.state === "deleted"))
      fail("accessObservation", "A removed post and a deleted-access observation must agree.");
  }
});
export type PostEvidence = z.infer<typeof postEvidenceSchema>;

export const recentPostMetadataSchema = z.object({
  postId: id,
  canonicalMediaId: id,
  publishedAt: instant.nullable(),
  relevant: z.boolean(),
  pinned: z.boolean().nullable(),
  nativeLikes: nativeLikesSchema,
  views: viewsSchema,
  paid: z.enum(["yes", "no", "unknown"]),
}).strict();
export type RecentPostMetadata = z.infer<typeof recentPostMetadataSchema>;

const gateSchema = z.object({ id, status: z.enum(["pass", "fail", "unknown"]), sourceRef: sourceRef.nullable() }).strict();

/**
 * Aggregate audience proof. Only an authorized dated native report or a creator export with provenance can be verified.
 * There is deliberately no field for faces, voices, names, appearance, health or creator location.
 */
export const audienceEvidenceSchema = z.object({
  dimension: z.enum(["countryRegion", "ageBand", "language"]),
  buckets: z.array(z.object({ label, share: z.number().min(0).max(1) }).strict()).max(50).nullable(),
  sourceType: z.enum(["authorizedNativeAnalytics", "datedCreatorExport", "publicSelfDescription"]),
  periodStart: instant.nullable(), periodEnd: instant.nullable(), observedAt: instant,
  provenanceRef: sourceRef.nullable(), verified: z.boolean(),
}).strict().superRefine((audience, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (audience.verified && (audience.sourceType === "publicSelfDescription" || !audience.periodStart || !audience.periodEnd || !audience.provenanceRef || !audience.buckets))
    fail("verified", "Only a dated authorized native report or creator export with provenance is verified aggregate proof.");
  if ((audience.periodStart === null) !== (audience.periodEnd === null) || (audience.periodStart && audience.periodEnd && Date.parse(audience.periodEnd) <= Date.parse(audience.periodStart)))
    fail("periodEnd", "A report period has an ordered start and end.");
  if (audience.periodEnd && Date.parse(audience.periodEnd) > Date.parse(audience.observedAt)) fail("periodEnd", "A report cannot cover a period after it was observed.");
  if (audience.buckets && audience.buckets.reduce((sum, bucket) => sum + bucket.share, 0) > 1.0001) fail("buckets", "Aggregate shares cannot exceed the whole.");
});
export type AudienceEvidence = z.infer<typeof audienceEvidenceSchema>;

/** Why an observed post is outside the deep-reviewed packet. Each stays visible; none becomes zero evidence. */
export const collectionExclusionSchema = z.enum([
  "LIKES_NOT_ABOVE_200", "LIKES_PENDING_PROOF", "NOT_RELEVANT_TO_BRIEF", "CONTEXT_NOT_LIFESTYLE", "CONTEXT_UNKNOWN",
  "EXCLUDED_CLINICAL_LECTURE", "EXCLUDED_IVF_FERTILITY_EXPLAINER", "EXCLUDED_GENERIC_MEDICAL_EDUCATION",
  "ACCESS_LOGIN_REQUIRED", "ACCESS_PERMISSION_DENIED", "ACCESS_UNAVAILABLE", "POST_REMOVED", "REVIEW_IGNORED_BELOW_GATE",
]);
/** The J20 version marker and run-level source facts for a collected packet. Derived counts are projected, never stored. */
export const collectionSchema = z.object({
  schemaVersion: z.literal(VIDEO_EVIDENCE_SCHEMA_VERSION),
  collectorVersion: id,
  /** A synthetic fixture collector is always labeled as such; only a qualified real collector reports `source`. */
  collectorStage: z.enum(["synthetic-fixture", "source"]),
  samplingPolicyVersion: z.literal(J20_SAMPLING_POLICY_VERSION),
  taxonomyVersion: z.literal(J20_TAXONOMY_VERSION),
  briefVersion: id,
  sourceReceiptRef: sourceRef,
  observedAt: instant,
  /** Candidates the source listed for this creator, or null when the source did not say. */
  listedPosts: count.max(10_000).nullable(),
  /** The recent-post window the source listed from (VideoEvidenceRecord `policy_window`). */
  policyWindow: z.object({ start: instant.nullable(), end: instant, timezone: z.string().min(1).max(64) }).strict().optional(),
  exclusions: z.array(z.object({ postId: id, reasons: z.array(collectionExclusionSchema).min(1).max(8), observedAt: instant }).strict()).max(200),
  audience: z.array(audienceEvidenceSchema).max(20),
  /** Farda-authored text withheld by the inference screen. The text itself is never stored. */
  quarantined: z.array(z.object({ postId: id, field: z.string().min(1).max(120), reasonCodes: z.array(code).min(1).max(10) }).strict()).max(100),
}).strict().superRefine((collection, ctx) => {
  if (new Set(collection.exclusions.map(entry => entry.postId)).size !== collection.exclusions.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exclusions"], message: "List each excluded post once with all of its reasons." });
});
export type EvidenceCollection = z.infer<typeof collectionSchema>;

const packetShapeSchema = z.object({
  creatorId: id,
  briefId: id,
  checkoutRoute: z.enum(["website", "tiktok-shop"]),
  evidenceRevision: id,
  termsRevision: id,
  posts: z.array(postEvidenceSchema).max(50),
  recentPosts: z.array(recentPostMetadataSchema).max(100),
  ratings: z.object({ routine: rating, demo: rating }).strict(),
  /** Extra configured criteria remain absent/unknown unless supplied; these never invent missing weights. */
  criterionRatings: z.record(id, rating).default({}),
  /** Noncritical ratings count only alongside source-linked evidence, never as unsupported numbers. */
  criterionEvidenceRefs: z.record(id, z.array(sourceRef).min(1)).default({}),
  invitationGates: z.array(gateSchema).max(100),
  activationGates: z.array(gateSchema).max(100),
  /** Present only on packets written by the J20 collector; it versions every J20 field below it. */
  collection: collectionSchema.optional(),
}).strict().superRefine((packet, ctx) => {
  for (const key of ["posts", "recentPosts"] as const)
    if (new Set(packet[key].map((post) => post.postId)).size !== packet[key].length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Post IDs must be unique within each record set." });
  if (packet.collection) {
    if (packet.posts.some(post => !post.source))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["posts"], message: "A J20-collected packet carries source provenance on every reviewed post." });
    const reviewed = new Set(packet.posts.map(post => post.postId));
    if (packet.collection.exclusions.some(entry => reviewed.has(entry.postId)))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["collection", "exclusions"], message: "An excluded post cannot also sit in the reviewed packet." });
  }
  if (new Set(packet.posts.map(nativePostIdentity)).size !== packet.posts.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["posts"], message: "The same native asset cannot be submitted under different record IDs." });
  for (const key of ["invitationGates", "activationGates"] as const)
    if (new Set(packet[key].map((gate) => gate.id)).size !== packet[key].length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Gate IDs must be unique within each phase." });
});
export type EvidencePacket = z.infer<typeof packetShapeSchema>;
export const evidencePacketSchema: z.ZodType<EvidencePacket, z.ZodTypeDef, z.input<typeof packetShapeSchema>> = packetShapeSchema;

const viewGroupSchema = z.object({
  definition: reason, window: reason, paid: z.enum(["yes", "no", "unknown"]), count: count.positive(),
  median: z.number().finite().nonnegative(), min: count, max: count, spread: count,
}).strict().refine((group) => group.min <= group.median && group.median <= group.max && group.spread === group.max - group.min,
  { message: "View distribution bounds and spread must agree." });

export const metadataBaselineSchema = z.object({
  requestedCount: z.literal(10),
  selected: z.array(recentPostMetadataSchema).max(10),
  totalProvided: count.max(100),
  relevantCount: count.max(100),
  unknownDateCount: count.max(100),
  unknownPinnedCount: count.max(100),
  coverage: z.enum(["complete", "partial"]),
  coverageReasons: z.array(reason),
  viewStats: z.object({
    status: z.enum(["known", "partial", "incomparable", "unknown"]),
    knownCount: count,
    missingCount: count,
    definition: reason.nullable(),
    window: reason.nullable(),
    paid: z.enum(["yes", "no", "unknown"]).nullable(),
    median: z.number().finite().nonnegative().nullable(),
    min: count.nullable(), max: count.nullable(), spread: count.nullable(),
    groups: z.array(viewGroupSchema).max(10),
  }).strict(),
}).strict().superRefine((baseline, ctx) => {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (baseline.selected.some((post) => !post.relevant || post.pinned !== false || post.publishedAt === null))
    fail(["selected"], "Selected baseline rows must have known dates, be relevant and be unpinned.");
  if (baseline.totalProvided < baseline.relevantCount || baseline.relevantCount < baseline.selected.length || baseline.unknownDateCount > baseline.relevantCount || baseline.unknownPinnedCount > baseline.relevantCount)
    fail(["totalProvided"], "Baseline selection counts cannot exceed supplied records.");
  const complete = baseline.selected.length === 10 && baseline.unknownDateCount === 0 && baseline.unknownPinnedCount === 0 && baseline.coverageReasons.length === 0;
  if ((baseline.coverage === "complete") !== complete) fail(["coverage"], "Coverage must retain missing rows and uncertain dates/pinned states.");
  const views = baseline.viewStats;
  if (views.knownCount + views.missingCount !== baseline.selected.length || views.groups.reduce((sum, group) => sum + group.count, 0) !== views.knownCount)
    fail(["viewStats"], "View counts must reconcile to the selected rows and compatible groups.");
  const only = views.groups.length === 1 ? views.groups[0]! : null;
  if (only) {
    const keys = ["definition", "window", "paid", "median", "min", "max", "spread"] as const;
    if (keys.some((key) => views[key] !== only[key])) fail(["viewStats"], "A comparable summary must use its one group's exact basis and statistics.");
    const expected = views.missingCount || baseline.coverage === "partial" ? "partial" : "known";
    if (views.status !== expected) fail(["viewStats", "status"], "The summary must retain incomplete view/baseline coverage.");
  } else {
    if ([views.definition, views.window, views.paid, views.median, views.min, views.max, views.spread].some((value) => value !== null))
      fail(["viewStats"], "Do not combine unknown or incompatible view groups into one statistic.");
    if (views.status !== (views.knownCount ? "incomparable" : "unknown")) fail(["viewStats", "status"], "Unavailable or incompatible views must stay explicit.");
  }
});
export type MetadataBaseline = z.infer<typeof metadataBaselineSchema>;

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]! / 2 + sorted[mid]! / 2;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]!, spread: sorted[sorted.length - 1]! - sorted[0]! };
}

/** Latest known unpinned relevant metadata, including ordinary/low-like posts. No video review or qualification occurs here. */
export function deriveMetadataBaseline(input: readonly RecentPostMetadata[]): MetadataBaseline {
  const posts = z.array(recentPostMetadataSchema).max(100).parse(input);
  if (new Set(posts.map((post) => post.postId)).size !== posts.length) throw new Error("Duplicate metadata post IDs.");
  const relevant = posts.filter((post) => post.relevant);
  const unknownPinnedCount = relevant.filter((post) => post.pinned === null).length;
  const unknownDateCount = relevant.filter((post) => post.pinned !== true && post.publishedAt === null).length;
  const selected = relevant.filter((post) => post.pinned === false && post.publishedAt !== null)
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!) || a.postId.localeCompare(b.postId)).slice(0, 10);
  const coverageReasons: string[] = [];
  if (selected.length < 10) coverageReasons.push("INSUFFICIENT_KNOWN_POSTS");
  if (unknownDateCount) coverageReasons.push("UNKNOWN_PUBLICATION_DATE");
  if (unknownPinnedCount) coverageReasons.push("UNKNOWN_PINNED_STATE");
  const buckets = new Map<string, { definition: string; window: string; paid: RecentPostMetadata["paid"]; values: number[] }>();
  for (const post of selected) {
    if (post.views.status !== "known") continue;
    const { definition, window, value } = post.views;
    const key = JSON.stringify([definition, window, post.paid]);
    const group = buckets.get(key) ?? { definition, window, paid: post.paid, values: [] };
    group.values.push(value);
    buckets.set(key, group);
  }
  const groups = [...buckets.values()].map(({ values, ...basis }) => ({ ...basis, count: values.length, ...distribution(values) }));
  const knownCount = groups.reduce((sum, group) => sum + group.count, 0);
  const missingCount = selected.length - knownCount;
  const only = groups.length === 1 ? groups[0]! : null;
  return metadataBaselineSchema.parse({
    requestedCount: 10, selected, totalProvided: posts.length, relevantCount: relevant.length,
    unknownDateCount, unknownPinnedCount, coverage: coverageReasons.length ? "partial" : "complete", coverageReasons,
    viewStats: {
      status: !knownCount ? "unknown" : !only ? "incomparable" : missingCount || coverageReasons.length ? "partial" : "known",
      knownCount, missingCount, definition: only?.definition ?? null, window: only?.window ?? null, paid: only?.paid ?? null,
      median: only?.median ?? null, min: only?.min ?? null, max: only?.max ?? null, spread: only?.spread ?? null, groups,
    },
  });
}

const categoryCountsSchema = z.object({
  generalReaction: count, routineApplication: count, productUnderstanding: count, practicalObjection: count,
  purchaseEvaluation: count, promptedKeyword: count, selfReportedOwnership: count,
}).strict();
export type CommentCategoryCounts = z.infer<typeof categoryCountsSchema>;

export const commentStatsSchema = z.object({
  status: z.enum(["observed", "unknown", "unavailable"]),
  reason: reason.nullable(), ordering: reason.nullable(), observedAt: instant.nullable(),
  observedRows: count.max(20).nullable(), knownUniqueAuthors: count.nullable(), uniqueAuthors: count.nullable(), unknownAuthorRows: count.nullable(),
  audienceRows: count.nullable(), creatorRows: count.nullable(), promotionalRows: count.nullable(), promptedRows: count.nullable(),
  categoryCounts: categoryCountsSchema.nullable(),
  categoryKnownAuthorCounts: categoryCountsSchema.nullable(),
  unpromptedAudienceCategoryCounts: categoryCountsSchema.nullable(),
}).strict().superRefine((stats, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const counts = [stats.observedRows, stats.knownUniqueAuthors, stats.unknownAuthorRows, stats.audienceRows, stats.creatorRows, stats.promotionalRows, stats.promptedRows];
  if (stats.status !== "observed") {
    if (!stats.reason || [stats.ordering, stats.observedAt, stats.uniqueAuthors, ...counts, stats.categoryCounts, stats.categoryKnownAuthorCounts, stats.unpromptedAudienceCategoryCounts].some((value) => value !== null))
      fail("Unavailable comment evidence needs a reason and unknown counts, never fabricated zeroes.");
    return;
  }
  if (stats.reason !== null || !stats.ordering || !stats.observedAt || counts.some((value) => value === null) || !stats.categoryCounts || !stats.categoryKnownAuthorCounts || !stats.unpromptedAudienceCategoryCounts) {
    fail("Observed comment summaries need their actual sample, denominators and category counts.");
    return;
  }
  const rows = stats.observedRows!;
  if (counts.some((value) => value! > rows) || stats.knownUniqueAuthors! > rows - stats.unknownAuthorRows!) fail("Comment sample counts must reconcile to observed rows.");
  if (stats.uniqueAuthors !== (stats.unknownAuthorRows ? null : stats.knownUniqueAuthors)) fail("Unique authors remain unknown when any author reference is missing.");
  for (const category of commentCategorySchema.options) {
    if (stats.categoryCounts[category] > rows || stats.categoryKnownAuthorCounts[category] > Math.min(stats.knownUniqueAuthors!, stats.categoryCounts[category]) || stats.unpromptedAudienceCategoryCounts[category] > Math.min(stats.audienceRows!, stats.categoryCounts[category]))
      fail("Category counts use observed rows and known authors; overlapping tags are not additional buyers.");
  }
});
export type CommentStats = z.infer<typeof commentStatsSchema>;

const emptyCategories = (): CommentCategoryCounts => ({
  generalReaction: 0, routineApplication: 0, productUnderstanding: 0, practicalObjection: 0,
  purchaseEvaluation: 0, promptedKeyword: 0, selfReportedOwnership: 0,
});

/** Overlapping descriptive counts, never a buyer probability, conversion rate or attributed order count. */
export function deriveCommentStats(input: CommentSample): CommentStats {
  const sample = commentsSchema.parse(input);
  if (sample.status !== "observed") return commentStatsSchema.parse({
    status: sample.status, reason: sample.reason, ordering: null, observedAt: null,
    observedRows: null, knownUniqueAuthors: null, uniqueAuthors: null, unknownAuthorRows: null,
    audienceRows: null, creatorRows: null, promotionalRows: null, promptedRows: null,
    categoryCounts: null, categoryKnownAuthorCounts: null, unpromptedAudienceCategoryCounts: null,
  });
  const categoryCounts = emptyCategories();
  const categoryKnownAuthorCounts = emptyCategories();
  const unpromptedAudienceCategoryCounts = emptyCategories();
  const authors = new Set<string>();
  const categoryAuthors = new Map<CommentCategory, Set<string>>(commentCategorySchema.options.map((category) => [category, new Set<string>()]));
  let unknownAuthorRows = 0;
  for (const row of sample.rows) {
    if (row.authorRef === null) unknownAuthorRows++;
    else authors.add(row.authorRef);
    for (const category of row.categories) {
      categoryCounts[category]++;
      if (row.authorRef !== null) categoryAuthors.get(category)!.add(row.authorRef);
      if (!row.creator && !row.promotional && !row.prompted) unpromptedAudienceCategoryCounts[category]++;
    }
  }
  for (const category of commentCategorySchema.options) categoryKnownAuthorCounts[category] = categoryAuthors.get(category)!.size;
  return commentStatsSchema.parse({
    status: "observed", reason: null, ordering: sample.ordering, observedAt: sample.observedAt,
    observedRows: sample.rows.length, knownUniqueAuthors: authors.size, uniqueAuthors: unknownAuthorRows ? null : authors.size, unknownAuthorRows,
    audienceRows: sample.rows.filter((row) => !row.creator && !row.promotional).length,
    creatorRows: sample.rows.filter((row) => row.creator).length,
    promotionalRows: sample.rows.filter((row) => row.promotional).length,
    promptedRows: sample.rows.filter((row) => row.prompted).length,
    categoryCounts, categoryKnownAuthorCounts, unpromptedAudienceCategoryCounts,
  });
}
