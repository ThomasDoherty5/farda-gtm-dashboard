import { digest } from "../config.ts";
import { nativePostIdentity } from "../evidence.ts";
import type { SourceRef } from "../intake/contract.ts";
import { VideoEvidenceError, type LedgerReceipt, type VideoEvidenceLedger } from "./ledger.ts";
import {
  audienceProofState, classifyContext, deriveViewing, evidenceRefOf, isFullReview, likeGateOf, narratedWithinCoverage, packetCoverage,
  recordNextAction, shownWithinCoverage,
} from "./rules.ts";
import {
  COLLECTOR_VERSION, VIDEO_EVIDENCE_SCHEMA_VERSION, actorSchema, j20InputSchema, j20OutputSchema, postMetadataSchema, reviewReadSchema, sourceReadSchema,
  type AccessFailure, type CommentEvidence, type J20Input, type J20Output, type NextAction, type Platform, type PostMetadata,
  type PostReview, type VideoEvidenceRecord,
} from "./schema.ts";

/**
 * Injected source reader. Trusted server configuration supplies it; it is bound to an authorized route and never receives
 * credentials from the job input. It must report login, MFA, denial, removal and change instead of working around them.
 */
export interface VideoSourceReader {
  readPost(request: { platform: Platform; postRef: SourceRef; creatorRef: SourceRef; permissionRefs: string[] }): Promise<unknown>;
  reviewPost(request: { platform: Platform; postRef: SourceRef; brief: J20Input["briefRef"]; permissionRefs: string[]; metadata: PostMetadata }): Promise<unknown>;
}
export type CollectStep =
  | { state: "completed"; output: J20Output; receipts: LedgerReceipt[]; recordCount: number }
  | { state: "checkpoint"; nextCursor: string; receipts: LedgerReceipt[]; recordCount: number }
  | { state: "blocked"; failure: AccessFailure; cursor: string; receipts: LedgerReceipt[]; recordCount: number };
type Invoke = <T>(operation: () => Promise<T>) => Promise<T>;

const NOT_COLLECTED: CommentEvidence = { sample: { status: "unknown", reason: "Comments are sampled only for qualifying posts." }, declared_n: null, source_ref: "j20:not-collected", visible_author_count: null };
const ACTION_ORDER: NextAction[] = ["source_unavailable", "needs_metric_proof", "needs_playback", "needs_claim_review", "needs_audience_proof", "review_complete"];
const camel = { review_complete: "reviewComplete", needs_playback: "needsPlayback", needs_metric_proof: "needsMetricProof", needs_audience_proof: "needsAudienceProof",
  needs_claim_review: "needsClaimReview", source_unavailable: "sourceUnavailable" } as const;

export function creatorSourceIdOf(input: J20Input): string {
  const id = input.creatorRef.identityState === "resolved" ? input.creatorRef.sourceId ?? input.creatorRef.canonicalId : null;
  if (!id) throw new VideoEvidenceError("CREATOR_IDENTITY_UNRESOLVED", 422);
  return id;
}
/** Native ID when the authorized input has one; otherwise a controlled fingerprint of the canonical address. Never an invented ID. */
export function canonicalPostKey(postRef: SourceRef): string {
  const platform = postRef.source as Platform;
  if (postRef.sourceId) return `${platform}:${postRef.sourceId}`;
  if (!postRef.url) throw new VideoEvidenceError("POST_IDENTITY_UNRESOLVED", 422);
  return `fp:${platform}:${digest(nativePostIdentity({ sourceUrl: postRef.url, network: platform })).slice(0, 40)}`;
}
export function recordKeyOf(input: J20Input, postRef: SourceRef): string {
  return `j20-${digest([postRef.source, creatorSourceIdOf(input), canonicalPostKey(postRef)]).slice(0, 40)}`;
}
const inputIdentity = (input: J20Input) => digest({ creator: input.creatorRef, profile: input.profileRef, posts: input.postRefs, brief: input.briefRef,
  sampling: input.samplingPolicyVersion, taxonomy: input.taxonomyVersion, policy: input.policyVersion, permissions: input.sourcePermissionRefs });
/** Cursor: the next post and, for a gated post whose metadata is staged, the exact stage to review. */
type Position = { index: number; stage: string | null };
function cursorOf(input: J20Input, position: Position) {
  return `j20c:${inputIdentity(input).slice(0, 16)}:${position.index}${position.stage ? `:r:${position.stage}` : ""}`;
}
function startOf(input: J20Input, cursor: string | null): Position {
  if (cursor === null) return { index: 0, stage: null };
  const match = /^j20c:([a-f0-9]{16}):(\d+)(?::r:([a-f0-9]{40}))?$/.exec(cursor);
  if (!match || match[1] !== inputIdentity(input).slice(0, 16) || Number(match[2]) > input.postRefs.length) throw new VideoEvidenceError("CHECKPOINT_INPUT_MISMATCH", 409);
  return { index: Number(match[2]), stage: match[3] ?? null };
}

function assertIdentity(input: J20Input, postRef: SourceRef, metadata: PostMetadata) {
  const platform = postRef.source as Platform;
  const sameUrl = postRef.url ? nativePostIdentity({ sourceUrl: postRef.url, network: platform }) === nativePostIdentity({ sourceUrl: metadata.canonical_url, network: platform }) : true;
  if (metadata.platform !== platform || metadata.creator_source_id !== creatorSourceIdOf(input) || !sameUrl
    || (postRef.sourceId !== null && metadata.post_source_id !== postRef.sourceId)) throw new VideoEvidenceError("SOURCE_IDENTITY_MISMATCH", 502);
  if (!input.sourcePermissionRefs.includes(metadata.permission_ref)) throw new VideoEvidenceError("SOURCE_PERMISSION_NOT_IN_SCOPE", 403);
}

/** Builds one immutable record version from observed metadata and, for a gated post, its review. Nothing is inferred. */
export function buildRecord(input: J20Input, postRef: SourceRef, metadata: PostMetadata, review: PostReview | null,
  prior: VideoEvidenceRecord | null, reviewJobId: string): VideoEvidenceRecord {
  const like = likeGateOf(metadata.likes);
  const context = classifyContext(metadata.context, metadata.relevant);
  const eligible = like.state === "pass" && context.relevant;
  const limitations = new Set<string>();
  const exclusions = [...(like.state === "pass" ? [] : [like.reason_code]), ...context.exclusions];
  if (eligible && !review) throw new VideoEvidenceError("DEEP_REVIEW_MISSING", 500);
  const viewing = eligible && review ? deriveViewing(review.viewing) : null;
  const features = eligible && review ? review.features : [];
  for (const f of features) {
    if (f.status !== "observed") continue;
    if (f.channel === "shown" && !shownWithinCoverage(viewing, f.video_timestamp!)) limitations.add("SHOWN_FEATURE_OUTSIDE_OBSERVED_RANGE");
    if (f.channel !== "shown" && !narratedWithinCoverage(viewing, f)) limitations.add("NARRATED_FEATURE_OUTSIDE_ASSESSED_AUDIO");
  }
  if (viewing && !isFullReview(viewing)) limitations.add(viewing.status === "sampled_playback" ? "SAMPLED_FRAMES_NOT_CONTINUOUS" : `VIEWING_${viewing.status.toUpperCase()}`);
  if (viewing && viewing.audio_method === "asr") limitations.add("MACHINE_TRANSCRIPT_NOT_HEARD_AUDIO");
  if (viewing && viewing.audio_method === "unassessed") limitations.add("AUDIO_UNASSESSED");
  if (viewing && viewing.playback_elapsed_seconds !== null && viewing.status !== "complete_audio_visual") limitations.add("ELAPSED_PLAYBACK_NOT_COVERAGE");
  if (metadata.metrics.some((m) => m.value === null)) limitations.add("METRIC_FIELDS_MISSING");
  if (!features.some((f) => f.feature_key === "cta" && f.status === "observed") && eligible) limitations.add("NO_RETAIL_CTA_NOT_REQUIRED");
  if (metadata.shoppable_context.status !== "observed") limitations.add("SHOP_LINKAGE_UNPROVEN_NOT_REQUIRED");
  if (!eligible && like.state !== "pass") limitations.add(like.state === "fail" ? "METADATA_ONLY_BELOW_GATE" : "DEEP_REVIEW_PENDING_LIKE_PROOF");
  const version = (prior?.keys.evidence_version ?? 0) + 1;
  const published = metadata.published_at ? Date.parse(metadata.published_at) : null;
  const draft: Omit<VideoEvidenceRecord, "next_action"> = {
    schema_version: VIDEO_EVIDENCE_SCHEMA_VERSION, collector_version: COLLECTOR_VERSION,
    keys: { platform: metadata.platform, creator_source_id: metadata.creator_source_id, post_source_id: metadata.post_source_id,
      canonical_post_key: canonicalPostKey(postRef), canonical_url: metadata.canonical_url, evidence_version: version, review_job_id: reviewJobId },
    brief: input.briefRef,
    review_policy: { sampling_policy_version: input.samplingPolicyVersion, taxonomy_version: input.taxonomyVersion, policy_version: input.policyVersion },
    source: { route: metadata.route, provider_account_scope: metadata.provider_account_scope, permission_ref: metadata.permission_ref,
      permission_checked_at: metadata.permission_checked_at, published_at: metadata.published_at, retrieved_at: metadata.retrieved_at,
      source_content_fingerprint: metadata.source_content_fingerprint, access_state: "permitted", deleted_or_changed: false, evidence_refs: metadata.evidence_refs },
    sampling: { taxonomy_version: input.taxonomyVersion, primary_bucket: metadata.context.primary_bucket, secondary_labels: metadata.context.secondary_labels,
      excluded_topics: metadata.context.excluded_topics, relevant: context.relevant, selection_reason: metadata.context.selection_reason,
      pinned: metadata.pinned, paid: metadata.paid,
      post_age_days: published === null ? null : Math.max(0, Math.round(((Date.parse(metadata.retrieved_at) - published) / 86_400_000) * 10) / 10) },
    like_gate: like,
    deep_review: { eligible, credit: eligible, metadata_only: like.state !== "pass", exclusion_reasons: exclusions },
    viewing, features, production_choices: eligible && review ? review.production_choices : [],
    metrics: [metadata.likes, ...metadata.metrics], audience: eligible && review ? review.audience : [],
    claims: eligible && review ? review.claims : [], comments: eligible && review ? review.comments : NOT_COLLECTED,
    shoppable_context: metadata.shoppable_context, limitations: [...limitations].sort(), prior_version: prior?.keys.evidence_version ?? null,
  };
  return { ...draft, next_action: recordNextAction(draft) };
}

/** A removed or changed post becomes a new version. Earlier observations stay in their own versions and are not re-asserted. */
function lossRecord(prior: VideoEvidenceRecord, state: "removed" | "changed", observedAt: string, sourceRef: string, reviewJobId: string, fingerprint: string | null): VideoEvidenceRecord {
  const draft: Omit<VideoEvidenceRecord, "next_action"> = { ...prior,
    keys: { ...prior.keys, evidence_version: prior.keys.evidence_version + 1, review_job_id: reviewJobId },
    source: { ...prior.source, access_state: state, deleted_or_changed: true, retrieved_at: observedAt, evidence_refs: [sourceRef],
      source_content_fingerprint: state === "changed" ? fingerprint : prior.source.source_content_fingerprint },
    deep_review: { ...prior.deep_review, credit: false, exclusion_reasons: [...new Set([...prior.deep_review.exclusion_reasons, state === "removed" ? "POST_REMOVED" : "POST_CHANGED"])] },
    viewing: null, features: [], production_choices: [], claims: [], audience: [], comments: NOT_COLLECTED,
    limitations: [state === "removed" ? "POST_REMOVED_PRIOR_VERSIONS_PRESERVED" : "POST_CHANGED_NEEDS_NEW_REVIEW"], prior_version: prior.keys.evidence_version };
  return { ...draft, next_action: recordNextAction(draft) };
}

function summarize(input: J20Input, records: VideoEvidenceRecord[], missing: string[]): J20Output {
  const live = records.filter((r) => r.source.access_state === "permitted");
  const audience = records.flatMap((r) => r.audience);
  const acceptedAudience = audience.filter((a) => audienceProofState(a).accepted);
  const packet = packetCoverage(records, creatorSourceIdOf(input), input.briefRef.ref);
  const actions = new Set<NextAction>(records.map((r) => r.next_action));
  if (missing.length) actions.add("needs_playback");
  if (input.reviewRequirements.audienceProofRequired && !acceptedAudience.length) actions.add("needs_audience_proof");
  // A finished review that still lacks the 3-post / 2-date / 2-action packet needs more footage, never a zero or a pass.
  const packetShort = input.reviewRequirements.packetRequired && packet.status !== "packetComplete";
  if (packetShort && [...actions].every((a) => a === "review_complete")) actions.add("needs_playback");
  const nextAction = ACTION_ORDER.find((a) => actions.has(a)) ?? "review_complete";
  const statusCounts: Record<string, number> = {};
  for (const r of records) { const key = r.viewing?.status ?? (r.deep_review.metadata_only ? "metadata_only" : r.source.access_state === "permitted" ? "not_opened" : "unavailable"); statusCounts[key] = (statusCounts[key] ?? 0) + 1; }
  const bucketCounts: Record<string, number> = {};
  for (const r of live.filter((x) => x.sampling.relevant)) bucketCounts[r.sampling.primary_bucket] = (bucketCounts[r.sampling.primary_bucket] ?? 0) + 1;
  const limitations = new Set(records.flatMap((r) => r.limitations));
  if (missing.length) limitations.add("POSTS_NOT_OBSERVED");
  if (packetShort) limitations.add("PACKET_NEEDS_EVIDENCE");
  if (packet.baseline.coverage === "partial") limitations.add("BASELINE_PARTIAL_COVERAGE");
  for (const a of audience) if (!audienceProofState(a).accepted) limitations.add(audienceProofState(a).reason);
  return j20OutputSchema.parse({
    schemaVersion: VIDEO_EVIDENCE_SCHEMA_VERSION, collectorVersion: COLLECTOR_VERSION,
    evidenceRecordRefs: records.map(evidenceRefOf),
    viewingCoverage: {
      statusCounts, continuousFullReviews: records.filter((r) => isFullReview(r.viewing)).length,
      sampledFrameReviews: records.filter((r) => r.viewing?.status === "sampled_playback").length,
      records: records.map((r) => ({ evidenceRef: evidenceRefOf(r), status: r.viewing?.status ?? null, method: r.viewing?.method ?? null,
        visualCoveragePercent: r.viewing?.visual_coverage_percent ?? null, heardCoveragePercent: r.viewing?.heard_coverage_percent ?? null,
        sampledPointCount: r.viewing?.sampled_point_count ?? null, audioState: r.viewing?.audio_state ?? null, audioMethod: r.viewing?.audio_method ?? null,
        playbackElapsedSecondsNotCoverage: r.viewing?.playback_elapsed_seconds ?? null })),
    },
    contentMixAssessment: {
      samplingPolicyVersion: input.samplingPolicyVersion, taxonomyVersion: input.taxonomyVersion,
      requested: input.postRefs.length, accessible: live.length, eligible: live.filter((r) => r.deep_review.eligible).length,
      reviewed: live.filter((r) => r.deep_review.eligible && r.next_action !== "needs_playback").length,
      metadataOnly: live.filter((r) => r.like_gate.state === "fail").length, pendingLikeProof: live.filter((r) => r.like_gate.state === "pending").length,
      notObserved: missing.length,
      exclusions: records.filter((r) => r.deep_review.exclusion_reasons.length).map((r) => ({ evidenceRef: evidenceRefOf(r), reasons: r.deep_review.exclusion_reasons })),
      /** Observed counts only; never portfolio percentages or model weights. */
      bucketCounts,
      posts: records.map((r) => ({ evidenceRef: evidenceRefOf(r), ageDays: r.sampling.post_age_days, pinned: r.sampling.pinned, paid: r.sampling.paid, likeGate: r.like_gate.state })),
      packet: { status: packet.status, qualifyingPosts: packet.qualifyingPosts, publicationDates: packet.publicationDates, meaningfulUsePosts: packet.meaningfulUsePosts, gates: packet.gates },
      baseline: { requested: packet.baseline.requestedCount, selected: packet.baseline.selected.length, coverage: packet.baseline.coverage,
        reasons: packet.baseline.coverageReasons, views: packet.baseline.viewStats },
      comments: packet.comments,
      shopLinkageRequired: false,
    },
    metricObservations: records.flatMap((r) => r.metrics),
    audienceEvidence: audience,
    claimsReview: records.flatMap((r) => r.claims.map((claim) => ({ evidenceRef: evidenceRefOf(r), claim }))),
    limitations: [...limitations].sort(),
    nextAction: camel[nextAction],
  });
}

/** J20 collector: validates identity and the strict native-like gate, reviews only gated posts, and appends immutable versions. */
export class VideoEvidenceCollector {
  private readonly ledger: VideoEvidenceLedger;
  private readonly reader: VideoSourceReader;
  constructor(ledger: VideoEvidenceLedger, reader: VideoSourceReader) { this.ledger = ledger; this.reader = reader; }

  private read<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new VideoEvidenceError("SOURCE_RESPONSE_INVALID", 502);
    return parsed.data;
  }

  /**
   * Runs from the cursor until done, a source failure, the record bound or the call bound. Each source call reads one post.
   * A gated post takes two calls (metadata, then playback review); between them its metadata is staged under the run.
   */
  async collect(rawInput: unknown, options: { cursor: string | null; maxRecords: number; maxCalls?: number; runKey?: string; invoke?: Invoke }): Promise<CollectStep> {
    const parsed = j20InputSchema.safeParse(rawInput);
    if (!parsed.success) throw new VideoEvidenceError("J20_INPUT_INVALID", 422);
    const input = parsed.data;
    const maxCalls = options.maxCalls ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1 || !Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new VideoEvidenceError("RECORD_BOUND_INVALID", 422);
    creatorSourceIdOf(input);
    const invoke: Invoke = options.invoke ?? ((operation) => operation());
    const runKey = options.runKey ?? input.idempotencyKey;
    const receipts: LedgerReceipt[] = [];
    const position = startOf(input, options.cursor);
    let calls = 0;
    const call = <T>(operation: () => Promise<T>) => { calls++; return invoke(operation); };
    while (position.index < input.postRefs.length) {
      if (calls >= Math.min(maxCalls, options.maxRecords)) return { state: "checkpoint", nextCursor: cursorOf(input, position), receipts, recordCount: calls };
      const postRef = input.postRefs[position.index]!, platform = postRef.source as Platform, recordKey = recordKeyOf(input, postRef);
      const request = { requestKey: `j20-req-${digest([input.idempotencyKey, runKey, recordKey]).slice(0, 40)}`, requestHash: digest([inputIdentity(input), recordKey]), recordKey };
      const permissionRefs = [...input.sourcePermissionRefs];
      const next = () => { position.index++; position.stage = null; };
      const blocked = (failure: AccessFailure): CollectStep => {
        this.ledger.recordAccess({ recordKey, state: failure.state, sourceRef: failure.source_ref, observedAt: failure.observed_at, reasonCode: failure.reason_code, runKey });
        return { state: "blocked", failure, cursor: cursorOf(input, position), receipts, recordCount: calls };
      };
      const loss = (read: { state: "removed" | "changed"; source_ref: string; observed_at: string; source_content_fingerprint?: string | null }) => {
        if (!this.ledger.latest(recordKey))
          this.ledger.recordAccess({ recordKey, state: read.state, sourceRef: read.source_ref, observedAt: read.observed_at, reasonCode: read.state === "removed" ? "POST_REMOVED" : "POST_CHANGED", runKey });
        else receipts.push(this.ledger.append({ ...request, build: (prior) => lossRecord(prior!, read.state, read.observed_at, read.source_ref, runKey, read.source_content_fingerprint ?? null) }));
        next();
      };
      if (position.stage === null) {
        const first = this.read(sourceReadSchema, await call(() => this.reader.readPost({ platform, postRef, creatorRef: input.creatorRef, permissionRefs })));
        if (first.state === "removed" || first.state === "changed") { loss(first); continue; }
        if (first.state !== "observed") return blocked(first);
        const metadata = first.observation;
        assertIdentity(input, postRef, metadata);
        const prior = this.ledger.latest(recordKey);
        if (prior?.source.source_content_fingerprint && metadata.source_content_fingerprint && prior.source.source_content_fingerprint !== metadata.source_content_fingerprint)
          receipts.push(this.ledger.append({ ...request, requestKey: `${request.requestKey}-changed`,
            build: (latest) => lossRecord(latest!, "changed", metadata.retrieved_at, metadata.permission_ref, runKey, metadata.source_content_fingerprint) }));
        if (likeGateOf(metadata.likes).state === "pass" && classifyContext(metadata.context, metadata.relevant).relevant) {
          // Only a post strictly above the native-like gate and in an approved lifestyle context is opened for playback.
          position.stage = digest([runKey, recordKey, metadata]).slice(0, 40);
          this.ledger.stage(position.stage, recordKey, metadata);
          continue;
        }
        receipts.push(this.ledger.append({ ...request, build: (latest) => buildRecord(input, postRef, metadata, null, latest, runKey) }));
        next();
        continue;
      }
      const staged = this.ledger.staged(position.stage);
      if (staged === null) throw new VideoEvidenceError("CHECKPOINT_STAGE_MISSING", 409);
      const metadata = this.read(postMetadataSchema, staged);
      const second = this.read(reviewReadSchema, await call(() => this.reader.reviewPost({ platform, postRef, brief: input.briefRef, permissionRefs, metadata })));
      if (second.state === "removed" || second.state === "changed") { loss(second); continue; }
      if (second.state !== "observed") return blocked(second);
      const review = second.review;
      receipts.push(this.ledger.append({ ...request, build: (latest) => buildRecord(input, postRef, metadata, review, latest, runKey) }));
      next();
    }
    const records: VideoEvidenceRecord[] = [], missing: string[] = [];
    for (const postRef of input.postRefs) {
      const latest = this.ledger.latest(recordKeyOf(input, postRef));
      if (latest) records.push(latest); else missing.push(canonicalPostKey(postRef));
    }
    return { state: "completed", output: summarize(input, records, missing), receipts, recordCount: calls };
  }
}

/**
 * The human exception path for uncertain compatibility, medical or outcome claims. Only a reviewer or owner decides; the agent never
 * diagnoses, infers viewer health or promises outcomes. The decision is a new version; the pending version stays readable.
 */
export function decideClaim(ledger: VideoEvidenceLedger, request: { recordKey: string; expectedVersion: number; claimId: string;
  decision: "accepted" | "rejected"; actor: unknown; requestKey: string }): LedgerReceipt {
  const actor = actorSchema.safeParse(request.actor);
  if (!actor.success || actor.data.role === "agent") throw new VideoEvidenceError("HUMAN_REVIEWER_REQUIRED", 403);
  const reviewer = actor.data.id;
  return ledger.append({ requestKey: `j20-claim-${digest([request.requestKey]).slice(0, 40)}`, requestHash: digest([request.recordKey, request.expectedVersion, request.claimId, request.decision, reviewer]),
    recordKey: request.recordKey, build: (prior, recordedAt) => {
      if (!prior || prior.keys.evidence_version !== request.expectedVersion) throw new VideoEvidenceError("STALE_VERSION");
      if (!prior.claims.some((c) => c.claim_id === request.claimId && c.human_review.status === "pending")) throw new VideoEvidenceError("CLAIM_NOT_PENDING");
      const claims = prior.claims.map((c) => c.claim_id === request.claimId ? { ...c, human_review: { status: request.decision, reviewer, decided_at: recordedAt } } : c);
      const draft = { ...prior, keys: { ...prior.keys, evidence_version: prior.keys.evidence_version + 1 }, claims, prior_version: prior.keys.evidence_version };
      return { ...draft, next_action: recordNextAction(draft) };
    } });
}
