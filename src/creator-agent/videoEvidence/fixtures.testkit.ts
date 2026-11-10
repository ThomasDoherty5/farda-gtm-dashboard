/** Synthetic J20 fixtures only. No real creator, handle, post, URL or metric is used; every identifier is fictional. */
import { AgentStore } from "../store.ts";
import type { SourceRef } from "../intake/contract.ts";
import { VideoEvidenceCollector, type VideoSourceReader } from "./collector.ts";
import { VideoEvidenceLedger } from "./ledger.ts";
import {
  SAMPLING_POLICY_VERSION, TAXONOMY_VERSION, type Feature, type J20Input, type MetricObservation, type ObservedInterval,
  type PostMetadata, type PostReview, type ViewingInput,
} from "./schema.ts";

export const SYNTHETIC_J20_SCOPE = { workspaceId: "synthetic-workspace", accountId: "synthetic-account" };
const AT = "2026-11-08T12:00:00.000Z";

const ref = (source: string, sourceId: string | null, url: string | null = null): SourceRef =>
  ({ source, accountId: "synthetic-account", sourceId, url, canonicalId: null, identityState: "resolved", provenanceRef: `synthetic:provenance:${sourceId ?? "fp"}` });
export const postRef = (n: number) => ref("instagram", `SYNTH${n}`, `https://www.instagram.com/reel/SYNTH${n}/`);

export function syntheticInput(posts = 3, overrides: Partial<J20Input> = {}): J20Input {
  return {
    jobId: "J20", jobVersion: "j20.v1", mode: "observe", actor: { id: "synthetic-agent", role: "agent" },
    accountRef: ref("farda-account", "synthetic-account"), policyVersion: "2026-11-04", inputHash: null,
    idempotencyKey: "synthetic-j20-run-1", correlationId: "synthetic-correlation-1", requestedAt: AT, deadline: null,
    creatorRef: ref("farda-creator", "synthetic-creator-1"), profileRef: ref("instagram", "synthetic-profile-1"),
    postRefs: Array.from({ length: posts }, (_, i) => postRef(i + 1)),
    briefRef: { ref: "synthetic-brief-travel-case", version: "v1" }, samplingPolicyVersion: SAMPLING_POLICY_VERSION, researchGateRef: "synthetic-research-gate",
    taxonomyVersion: TAXONOMY_VERSION, sourcePermissionRefs: ["synthetic-permission-1"],
    reviewRequirements: { audienceProofRequired: false, packetRequired: true }, priorEvidenceRefs: [], ...overrides,
  };
}

export function metric(key: MetricObservation["metric_key"], value: number | null, raw: string | null, extra: Partial<MetricObservation> = {}): MetricObservation {
  return {
    platform: "instagram", provider_product: "synthetic-native-counter", metric_key: key, definition_version: `synthetic-${key}-v1`, source_scope: "post",
    value, raw_display: raw, approximate: false, unit: "count", numerator_components: null, denominator_key: null, denominator_value: null,
    window: { start: null, end: AT, timezone: "UTC", period_or_lifetime: "lifetime" },
    cohort: { post_ids: [], creator_ids: [], product_ids: [], order_ids_or_private_link: null, organic_paid_mixed: "organic", post_age_range: null },
    refund_basis: "not_applicable", attribution_rule: null, currency: null, observed_at: AT, source_updated_at: null,
    source_url: `synthetic:metric:${key}`, source_type: "native_public_counter", derivation: null,
    missing_reason: value === null ? "hidden" : null, ...extra,
  };
}
export const likes = (value: number | null, raw: string | null = value === null ? "Hidden" : String(value), extra: Partial<MetricObservation> = {}) => metric("likes", value, raw, extra);

export function metadata(n: number, overrides: Partial<PostMetadata> = {}): PostMetadata {
  return {
    platform: "instagram", creator_source_id: "synthetic-creator-1", post_source_id: `SYNTH${n}`, canonical_url: `https://www.instagram.com/reel/SYNTH${n}/`,
    route: "public_native_ui", provider_account_scope: null, permission_ref: "synthetic-permission-1", permission_checked_at: AT,
    published_at: `2026-10-${String(Math.min(28, n)).padStart(2, "0")}T12:00:00.000Z`, retrieved_at: AT, source_content_fingerprint: `synthetic-fp-${n}`,
    pinned: false, paid: "no", relevant: true,
    context: { primary_bucket: "travel_purse", secondary_labels: [], excluded_topics: [], educator_or_credentialed: null, selection_reason: "ordinary_recent" },
    likes: likes(201), metrics: [metric("views", 1000 + n, String(1000 + n)), metric("shares", null, null, { missing_reason: "hidden" })],
    shoppable_context: { status: "unknown", product_ref: null, anchor_evidence_ref: null, observed_at: null },
    evidence_refs: [`synthetic:post-read:${n}`], ...overrides,
  };
}

const span = (start: number, end: number, modality: ObservedInterval["modality"]): ObservedInterval => ({ start_seconds: start, end_seconds: end, modality, evidence_ref: `synthetic:${modality}:${start}` });
const viewingBase = { duration_seconds: 30, playback_elapsed_seconds: 30, interruption_reason: null, reviewer: "synthetic-reviewer", reviewed_at: AT };
export const viewings: Record<"complete" | "sampled" | "captionOnly" | "muted" | "interrupted" | "notOpened" | "elapsedOnly" | "machineTranscript", ViewingInput> = {
  complete: { ...viewingBase, method: "continuous_native_playback", observed_intervals: [span(0, 30, "visual_continuous"), span(0, 30, "audio_heard")], audio_state: "heard", audio_method: "heard" },
  sampled: { ...viewingBase, method: "sampled_frames", observed_intervals: [0, 5, 10, 20].map((s) => span(s, s, "visual_frame")), audio_state: "unknown", audio_method: "unassessed" },
  captionOnly: { ...viewingBase, method: "caption_only", playback_elapsed_seconds: null, observed_intervals: [span(0, 30, "native_caption")], audio_state: "caption_only", audio_method: "nativeCaptions" },
  muted: { ...viewingBase, method: "continuous_native_playback", observed_intervals: [span(0, 30, "visual_continuous")], audio_state: "muted", audio_method: "unassessed" },
  interrupted: { ...viewingBase, method: "continuous_native_playback", observed_intervals: [span(0, 12, "visual_continuous")], playback_elapsed_seconds: 12, interruption_reason: "Synthetic player stopped", audio_state: "unknown", audio_method: "unassessed" },
  notOpened: { ...viewingBase, method: "none", observed_intervals: [], playback_elapsed_seconds: null, audio_state: "unknown", audio_method: "unassessed" },
  // The player ran for the full clip but only ten seconds were actually observed.
  elapsedOnly: { ...viewingBase, method: "continuous_native_playback", observed_intervals: [span(0, 10, "visual_continuous")], audio_state: "unknown", audio_method: "unassessed" },
  machineTranscript: { ...viewingBase, method: "continuous_native_playback", observed_intervals: [span(0, 30, "visual_continuous"), span(0, 30, "audio_machine_transcript")], audio_state: "unknown", audio_method: "asr" },
};

export function feature(key: Feature["feature_key"], at: number | null, channel: Feature["channel"], text: string | null, extra: Partial<Feature> = {}): Feature {
  return { feature_key: key, status: text ? "observed" : "not_observed", channel: text ? channel : null, ordinal_rating: null, evidence_ref: text ? `synthetic:feature:${key}:${at}` : null,
    video_timestamp: at, exact_observation: text, interpretation: null, brief_match: key === "handling_operation_use" && text ? "matched" : null,
    causality: key === "visible_outcome" ? "unresolved" : "not_applicable", ...extra };
}

export function review(viewing: ViewingInput = viewings.complete, overrides: Partial<PostReview> = {}): PostReview {
  return {
    viewing,
    features: [
      feature("hook", 0, "shown", "Opens on a fictional packed tote."),
      feature("handling_operation_use", viewing.method === "sampled_frames" ? 5 : 6, "shown", "Unzips a fictional case and places it in the tote.",
        { interpretation: { text: "Reviewer reads this as an on-brief travel use.", reviewer: "synthetic-reviewer" } }),
      feature("visible_outcome", viewing.method === "sampled_frames" ? 20 : 22, "shown", "The tote closes with the case inside."),
      feature("cta", null, null, null),
    ],
    claims: [], production_choices: [{ key: "framing", video_timestamp: 0, observation: "Top-down framing of the bag.", evidence_ref: "synthetic:production:framing" }],
    comments: { sample: { status: "observed", ordering: "First visible top-level rows in source order", observedAt: AT, rows: [
      { commentId: "synthetic-c1", authorRef: "synthetic-a1", creator: false, promotional: false, prompted: false, categories: ["purchaseEvaluation"], text: "Where is the fictional case from?" },
      { commentId: "synthetic-c2", authorRef: "synthetic-a2", creator: false, promotional: false, prompted: true, categories: ["promptedKeyword"], text: "FICTIONAL" },
    ] }, declared_n: 2, source_ref: "synthetic:comments", visible_author_count: 2 },
    audience: [], ...overrides,
  };
}

type Reply = unknown | (() => unknown);
/** A scripted reader. It counts calls so tests can prove a resume does not re-read committed posts. */
export class ScriptedReader implements VideoSourceReader {
  readonly meta = new Map<string, Reply>();
  readonly reviews = new Map<string, Reply>();
  readonly calls: string[] = [];
  async readPost(request: Parameters<VideoSourceReader["readPost"]>[0]) {
    const id = request.postRef.sourceId!; this.calls.push(`read:${id}`);
    const reply = this.meta.get(id); return typeof reply === "function" ? (reply as () => unknown)() : reply;
  }
  async reviewPost(request: Parameters<VideoSourceReader["reviewPost"]>[0]) {
    const id = request.postRef.sourceId!; this.calls.push(`review:${id}`);
    const reply = this.reviews.get(id); return typeof reply === "function" ? (reply as () => unknown)() : reply;
  }
  observe(n: number, meta: Partial<PostMetadata> = {}, rev: PostReview | null = review()) {
    this.meta.set(`SYNTH${n}`, { state: "observed", observation: metadata(n, meta) });
    if (rev) this.reviews.set(`SYNTH${n}`, { state: "observed", review: rev });
    return this;
  }
}

export function syntheticService(path = ":memory:", start = Date.parse("2026-11-08T13:00:00.000Z")) {
  let time = start;
  const store = new AgentStore(path, SYNTHETIC_J20_SCOPE);
  const ledger = new VideoEvidenceLedger(store, SYNTHETIC_J20_SCOPE, { now: () => time });
  const reader = new ScriptedReader();
  const collector = new VideoEvidenceCollector(ledger, reader);
  return { store, ledger, reader, collector, advance: (ms: number) => { time += ms; } };
}
