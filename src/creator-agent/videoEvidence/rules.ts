import { deriveCommentStats, deriveMetadataBaseline, evidencePacketSchema, postEvidenceSchema, type EvidenceReview, type PostEvidence, type RecentPostMetadata } from "../evidence.ts";
import { assessCreator, likeGate as j02LikeGate } from "../policy.ts";
import {
  type AudienceEvidence, type ContextInput, type Feature, type LikeGate, type MetricObservation,
  type NextAction, type ObservedInterval, type VideoEvidenceRecord, type Viewing, type ViewingInput, type ViewingStatus,
} from "./schema.ts";

/** Pure J20 rules. They label evidence and its coverage; J02 (policy.ts) decides qualification. */

type Span = { start: number; end: number };
function union(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
const spansOf = (intervals: ObservedInterval[], modality: ObservedInterval["modality"]) =>
  union(intervals.filter((i) => i.modality === modality).map((i) => ({ start: i.start_seconds, end: i.end_seconds })));
const covered = (spans: Span[]) => spans.reduce((sum, s) => sum + (s.end - s.start), 0);
/** Half a second of tolerance at each edge for frame-accurate players; nothing else counts as coverage. */
const EDGE_TOLERANCE = 0.5;
const coversWhole = (spans: Span[], duration: number) =>
  spans.length === 1 && spans[0]!.start <= EDGE_TOLERANCE && spans[0]!.end >= duration - EDGE_TOLERANCE;
const percent = (spans: Span[], duration: number | null) => duration === null ? null : Math.min(100, Math.round((covered(spans) / duration) * 1000) / 10);

/* ---------- Native-like gate (J20-05, J20-06, J20-13) ---------- */

const EXACT = /^\d{1,3}(?:,\d{3})+$|^\d+$/;
const ROUNDED = /^\d+(?:[.,]\d+)?\s*[KkMm]$/;
/**
 * Reads the raw native label and then applies the J02 gate unchanged: strictly more than 200 exact native likes passes,
 * exactly 200 fails, and hidden, absent, rounded, ambiguous or third-party counts stay pending.
 */
export function likeGateOf(metric: MetricObservation): LikeGate {
  const raw = metric.raw_display?.trim() ?? null;
  const base = { raw_label: metric.raw_display, source_type: metric.source_type, observed_at: metric.observed_at };
  const native = metric.source_type === "native_public_counter" || metric.source_type === "native_report";
  let parsed: LikeGate["parsed"];
  if (!native) parsed = "third_party";
  else if (metric.value === null) parsed = metric.missing_reason === "hidden" ? "hidden" : "absent";
  else if (raw && EXACT.test(raw) && Number(raw.replace(/,/g, "")) === metric.value && !metric.approximate) parsed = "exact";
  else if (raw && ROUNDED.test(raw)) parsed = "rounded";
  else parsed = "ambiguous";
  const nativeLikes: PostEvidence["nativeLikes"] = parsed === "exact" || parsed === "rounded"
    ? { status: "known", value: Math.trunc(metric.value!), exact: parsed === "exact", sourceRef: metric.source_url }
    : parsed === "hidden" ? { status: "unavailable", reason: "Native like count hidden at the source." }
      : { status: "unknown", reason: `Native like label ${parsed}.` };
  // policy.likeGate reads only nativeLikes; reusing it keeps J20 and J02 on one boundary.
  const gate = j02LikeGate({ nativeLikes } as PostEvidence);
  const value = parsed === "exact" ? metric.value : null;
  if (gate === "pass") return { ...base, state: "pass", parsed, value, reason_code: "NATIVE_LIKES_ABOVE_200" };
  if (gate === "fail") return { ...base, state: "fail", parsed, value, reason_code: "NATIVE_LIKES_NOT_ABOVE_200" };
  return { ...base, state: "pending", parsed, value, reason_code: `NATIVE_LIKES_${parsed.toUpperCase()}` };
}

/** Back-maps a stored gate to the J02 native-likes field without upgrading a pending label. */
function nativeLikesOf(record: VideoEvidenceRecord): PostEvidence["nativeLikes"] {
  const g = record.like_gate;
  if (g.parsed === "exact" && g.value !== null) return { status: "known", value: g.value, exact: true, sourceRef: record.metrics.find((m) => m.metric_key === "likes")?.source_url ?? "j20:likes" };
  if (g.parsed === "hidden") return { status: "unavailable", reason: "Native like count hidden at the source." };
  return { status: "unknown", reason: `Native like label ${g.parsed}.` };
}

/* ---------- Viewing status and modality coverage (J20-02) ---------- */

/** Status comes from observed ranges only. Elapsed player time is retained but never counts as coverage. */
export function deriveViewing(input: ViewingInput): Viewing {
  const visual = spansOf(input.observed_intervals, "visual_continuous");
  const heard = spansOf(input.observed_intervals, "audio_heard");
  const points = new Set(input.observed_intervals.filter((i) => i.modality === "visual_frame").map((i) => i.start_seconds)).size;
  const duration = input.duration_seconds;
  let status: ViewingStatus;
  if (input.method === "none") status = "not_opened";
  else if (input.method === "caption_only") status = "metadata_only";
  else if (input.method === "sampled_frames") status = points ? "sampled_playback" : "not_opened";
  else if (!visual.length) status = "not_opened";
  else if (duration !== null && coversWhole(visual, duration) && !input.interruption_reason)
    status = input.audio_method === "heard" && coversWhole(heard, duration) && input.audio_state === "heard" ? "complete_audio_visual" : "full_visual_only";
  else status = "partial_playback";
  return { ...input, status, visual_coverage_percent: input.method === "sampled_frames" ? null : percent(visual, duration),
    heard_coverage_percent: input.audio_method === "heard" ? percent(heard, duration) : null, sampled_point_count: points };
}
export const FULL_REVIEW_STATUSES: readonly ViewingStatus[] = ["full_visual_only", "complete_audio_visual"];
export const isFullReview = (v: Viewing | null) => Boolean(v && FULL_REVIEW_STATUSES.includes(v.status));

/** True when a shown observation sits inside what was actually seen: a continuous range or an exact sampled frame. */
export function shownWithinCoverage(viewing: Viewing | null, at: number): boolean {
  if (!viewing) return false;
  if (viewing.method === "sampled_frames") return viewing.observed_intervals.some((i) => i.modality === "visual_frame" && i.start_seconds === at);
  return spansOf(viewing.observed_intervals, "visual_continuous").some((s) => s.start <= at && at <= s.end);
}
/** A narrated or captioned fact needs the matching audio/caption assessment; narration never becomes a shown action. */
export function narratedWithinCoverage(viewing: Viewing | null, feature: Pick<Feature, "channel" | "video_timestamp">): boolean {
  if (!viewing || feature.video_timestamp === null) return false;
  const at = feature.video_timestamp;
  if (feature.channel === "caption_text") return viewing.observed_intervals.some((i) => i.modality === "native_caption" && i.start_seconds <= at && at <= i.end_seconds)
    || shownWithinCoverage(viewing, at);
  const modality = viewing.audio_method === "heard" ? "audio_heard" : viewing.audio_method === "asr" ? "audio_machine_transcript" : null;
  return modality !== null && spansOf(viewing.observed_intervals, modality).some((s) => s.start <= at && at <= s.end);
}

/* ---------- Lifestyle taxonomy (J20-07) ---------- */

const LIFESTYLE = new Set(["grwm", "workday", "organization", "travel_purse", "practical_product_use"]);
/** Approved lifestyle contexts only. Clinical, IVF/fertility and generic medical education are excluded; credentials add nothing. */
export function classifyContext(context: ContextInput, declaredRelevant: boolean): { relevant: boolean; exclusions: string[] } {
  const exclusions = context.excluded_topics.map((topic) => `EXCLUDED_${topic.toUpperCase()}`);
  if (!LIFESTYLE.has(context.primary_bucket)) exclusions.push(context.primary_bucket === "unknown" ? "CONTEXT_UNKNOWN" : "NOT_LIFESTYLE_CONTEXT");
  if (!declaredRelevant) exclusions.push("NOT_RELEVANT_TO_BRIEF");
  return { relevant: exclusions.length === 0, exclusions };
}

/* ---------- Audience proof (J20-08) ---------- */

/** Aggregate audience proof only from a verified, dated native report or creator export with provenance. */
export function audienceProofState(evidence: AudienceEvidence): { accepted: boolean; reason: string } {
  if (evidence.source_type === "public_self_description") return { accepted: false, reason: "PUBLIC_SELF_DESCRIPTION_NOT_AUDIENCE_PROOF" };
  if (!evidence.verified || !evidence.period || !evidence.provenance_ref || !evidence.value) return { accepted: false, reason: "AUDIENCE_REPORT_UNVERIFIED" };
  return { accepted: true, reason: "AUTHORIZED_DATED_AGGREGATE" };
}

/* ---------- Per-record next action ---------- */

const CLAIM_TOPICS_FOR_HUMAN = new Set(["compatibility", "medical", "outcome"]);
export function recordNextAction(record: Pick<VideoEvidenceRecord, "source" | "like_gate" | "deep_review" | "viewing" | "claims" | "limitations">): NextAction {
  if (record.source.access_state === "removed") return "source_unavailable";
  if (record.source.access_state === "changed") return "needs_playback";
  if (record.like_gate.state === "pending") return "needs_metric_proof";
  if (!record.deep_review.eligible) return "review_complete"; // metadata-only or excluded: nothing further to watch
  const v = record.viewing;
  const reviewed = v && (isFullReview(v) || (v.status === "sampled_playback" && !v.interruption_reason));
  if (!reviewed || record.limitations.includes("SHOWN_FEATURE_OUTSIDE_OBSERVED_RANGE")) return "needs_playback";
  // Uncertain compatibility/medical/outcome claims take the human exception path; the agent never resolves them.
  if (record.claims.some((c) => c.human_review.status === "pending" && (CLAIM_TOPICS_FOR_HUMAN.has(c.topic) || c.channel !== "shown"))) return "needs_claim_review";
  return "review_complete";
}

/* ---------- J02 packet mapping (reuses evidence.ts/policy.ts) ---------- */

function reviewOf(record: VideoEvidenceRecord, evidenceRef: string): EvidenceReview {
  const v = record.viewing;
  const audioMethod = v?.audio_method ?? "unassessed";
  const claims = record.claims.flatMap((c) => c.method === "visual" || (c.method === "heard" && audioMethod !== "heard") || (c.method === "asr" && audioMethod !== "asr") ? [] :
    [{ atSec: c.video_timestamp, text: c.summary, method: c.method }]);
  const actions = record.features.filter((f) => f.feature_key === "handling_operation_use" && f.status === "observed" && f.channel === "shown" && shownWithinCoverage(v, f.video_timestamp!))
    .map((f) => ({ atSec: f.video_timestamp!, action: f.exact_observation!, meaningfulUse: f.brief_match === "matched" }));
  const inferences = record.features.flatMap((f) => f.interpretation ? [f.interpretation.text] : []);
  const base = { reviewerRef: v?.reviewer, reviewedAt: v?.reviewed_at, inferences };
  if (!v || v.status === "not_opened" || !record.deep_review.eligible) {
    return { ...base, status: record.source.access_state === "removed" ? "blocked" : "unassessed", visualMethod: "unassessed", audioMethod: "unassessed",
      sampledPoints: [], watchedIntervals: [], observedActions: [], claims: [], inferences: [], sourceRef: null };
  }
  const heardIntervals = audioMethod === "heard" ? spansOf(v.observed_intervals, "audio_heard").map((s) => ({ startSec: s.start, endSec: s.end })) : undefined;
  if (v.status === "metadata_only")
    return { ...base, status: "partial", visualMethod: "unassessed", audioMethod, sampledPoints: [], watchedIntervals: [], observedActions: [], claims, sourceRef: null };
  if (v.method === "sampled_frames") {
    const points = [...new Set(v.observed_intervals.filter((i) => i.modality === "visual_frame").map((i) => i.start_seconds))];
    const complete = !v.interruption_reason && record.next_action !== "needs_playback";
    return { ...base, status: complete ? "complete" : "partial", visualMethod: "sampledFrames", audioMethod, heardIntervals,
      sampledPoints: points, watchedIntervals: [], observedActions: actions, claims, sourceRef: complete ? evidenceRef : null };
  }
  const complete = isFullReview(v) && record.next_action !== "needs_playback";
  return { ...base, status: complete ? "complete" : "partial", visualMethod: "continuous", audioMethod, heardIntervals, sampledPoints: [],
    watchedIntervals: spansOf(v.observed_intervals, "visual_continuous").map((s) => ({ startSec: s.start, endSec: s.end })),
    observedActions: actions, claims, sourceRef: complete ? evidenceRef : null };
}

const evidenceRefOf = (r: VideoEvidenceRecord) => `${r.keys.canonical_post_key}:v${r.keys.evidence_version}`;

/** Deep-reviewed posts as J02 PostEvidence. Metadata-only, pending and excluded posts never enter this list. */
export function toPostEvidence(record: VideoEvidenceRecord): PostEvidence | null {
  if (!record.deep_review.credit || record.source.access_state !== "permitted") return null;
  const ref = evidenceRefOf(record);
  return {
    postId: ref, canonicalMediaId: record.keys.canonical_post_key, network: record.keys.platform, sourceUrl: record.keys.canonical_url,
    publishedAt: record.source.published_at, observedAt: record.source.retrieved_at, relevant: record.sampling.relevant,
    nativeLikes: nativeLikesOf(record), review: reviewOf(record, ref), comments: record.comments.sample,
  };
}

/** Every relevant recent post, including lower-like ordinary posts, as reach-baseline metadata with no deep-review credit. */
export function toRecentMetadata(record: VideoEvidenceRecord): RecentPostMetadata {
  const views = record.metrics.find((m) => m.metric_key === "views" && m.source_scope === "post");
  return {
    postId: evidenceRefOf(record), canonicalMediaId: record.keys.canonical_post_key, publishedAt: record.source.published_at,
    relevant: record.sampling.relevant, pinned: record.sampling.pinned, nativeLikes: nativeLikesOf(record), paid: record.sampling.paid,
    views: views && views.value !== null ? { status: "known", value: Math.trunc(views.value), definition: views.definition_version, window: views.window.period_or_lifetime }
      : { status: views?.missing_reason === "hidden" || views?.missing_reason === "not_authorized" ? "unavailable" : "unknown", reason: `Views ${views?.missing_reason ?? "not_collected"}.` },
  };
}

/**
 * Packet coverage from the J02 gates (3 distinct relevant qualifying posts, 2 publication dates, 2 brief-matched action posts).
 * It runs J02 with no bound configuration, so no score exists; only the content gate counts are returned.
 */
export function packetCoverage(records: VideoEvidenceRecord[], creatorId: string, briefId: string) {
  // A post outside the J02 packet schema (for example a non-original video address) stays out rather than being reshaped.
  const posts = records.map(toPostEvidence).filter((p): p is PostEvidence => p !== null && postEvidenceSchema.safeParse(p).success);
  const seen = new Set<string>();
  const unique = posts.filter((p) => !seen.has(p.canonicalMediaId) && seen.add(p.canonicalMediaId));
  const packet = evidencePacketSchema.parse({ creatorId, briefId, checkoutRoute: "website", evidenceRevision: "j20-coverage", termsRevision: "j20-coverage",
    posts: unique.slice(0, 50), recentPosts: records.filter((r) => r.source.access_state === "permitted").slice(0, 100).map(toRecentMetadata), ratings: { routine: null, demo: null }, invitationGates: [], activationGates: [] });
  const assessment = assessCreator(packet, null);
  const contentGates = assessment.gates.filter((g) => ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE"].includes(g.id));
  return {
    qualifyingPosts: assessment.packet.qualifyingPosts, publicationDates: assessment.packet.publicationDates, meaningfulUsePosts: assessment.packet.meaningfulUsePosts,
    gates: contentGates, status: contentGates.every((g) => g.state === "pass") ? "packetComplete" as const : "needsEvidence" as const,
    baseline: deriveMetadataBaseline(packet.recentPosts),
    comments: packet.posts.map((p) => ({ postId: p.postId, ...deriveCommentStats(p.comments) })),
  };
}
export { evidenceRefOf };
