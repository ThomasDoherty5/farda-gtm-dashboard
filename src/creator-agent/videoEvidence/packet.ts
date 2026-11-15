import { digest } from "../config.ts";
import {
  APPROVED_LIFESTYLE_BUCKETS, J20_SAMPLING_POLICY_VERSION, J20_TAXONOMY_VERSION, VIDEO_EVIDENCE_SCHEMA_VERSION, evidencePacketSchema,
  isExactCountLabel, isRoundedCountLabel, nativePostIdentity,
  type EvidenceCollection, type EvidencePacket, type EvidenceReview, type NativeLikes, type PostEvidence, type RecentPostMetadata,
} from "../evidence.ts";
import { likeGate } from "../policy.ts";
import type { LikeObservation, SourcePost, VideoEvidenceSnapshot } from "./contract.ts";
import { inferenceRefusals, WITHHELD_INTERRUPTION } from "./inferenceScreen.ts";

type Exclusion = EvidenceCollection["exclusions"][number]["reasons"][number];
type Quarantined = EvidenceCollection["quarantined"][number];
type AccessState = NonNullable<PostEvidence["accessObservation"]>["state"];
const ACCESS: Record<SourcePost["access"], AccessState> = { permitted: "permitted", removed: "deleted", loginRequired: "loginRequired",
  permissionDenied: "permissionDenied", unavailable: "unavailable" };
const ACCESS_EXCLUSION: Record<Exclude<SourcePost["access"], "permitted">, Exclusion> = { removed: "POST_REMOVED",
  loginRequired: "ACCESS_LOGIN_REQUIRED", permissionDenied: "ACCESS_PERMISSION_DENIED", unavailable: "ACCESS_UNAVAILABLE" };
const CONTEXT_EXCLUSION = { clinicalLecture: "EXCLUDED_CLINICAL_LECTURE", ivfFertilityExplainer: "EXCLUDED_IVF_FERTILITY_EXPLAINER",
  genericMedicalEducation: "EXCLUDED_GENERIC_MEDICAL_EDUCATION" } as const;

/** Stable record identity from the creator and native post, never from a caller label. */
export const j20PostId = (creatorId: string, post: Pick<SourcePost, "sourceUrl" | "network">) =>
  `j20-${digest([creatorId, nativePostIdentity(post)]).slice(0, 32)}`;

/**
 * Reads the raw label, then lets the existing J02 gate decide: strictly more than 200 exact native likes passes, exactly 200
 * fails, and hidden, absent, rounded, ambiguous or third-party counts stay pending.
 */
export function nativeLikesOf(likes: LikeObservation): NativeLikes {
  const raw = likes.rawLabel ?? undefined;
  const withLabel = <T extends object>(value: T) => raw === undefined ? value : { ...value, rawLabel: raw };
  if (likes.sourceType === "thirdParty") return withLabel({ status: "unknown" as const, reason: "A third-party like count is not native evidence." });
  if (likes.value === null) return likes.missingReason === "hidden"
    ? withLabel({ status: "unavailable" as const, reason: "Native like count hidden at the source." })
    : withLabel({ status: "unknown" as const, reason: `Native like count ${likes.missingReason}.` });
  if (raw !== undefined && isExactCountLabel(raw, likes.value))
    return { status: "known", value: likes.value, exact: true, sourceRef: likes.sourceRef, rawLabel: raw };
  if (raw !== undefined && isRoundedCountLabel(raw))
    return { status: "known", value: likes.value, exact: false, sourceRef: likes.sourceRef, rawLabel: raw };
  return withLabel({ status: "unknown" as const, reason: "Native like label is ambiguous or missing." });
}

const unopened = (): EvidenceReview => ({ status: "unassessed", visualMethod: "unassessed", audioMethod: "unassessed", sampledPoints: [],
  watchedIntervals: [], observedActions: [], claims: [], inferences: [], sourceRef: null,
  durationSeconds: null, playbackElapsedSeconds: null, interruption: null, narration: [] });
/** A pre-J20 review gets explicit unknown playback facts so it can sit in a collected packet without gaining coverage. */
const withPlaybackFacts = (review: EvidenceReview): EvidenceReview => ({ ...review, durationSeconds: review.durationSeconds ?? null,
  playbackElapsedSeconds: review.playbackElapsedSeconds ?? null, interruption: review.interruption ?? null, narration: review.narration ?? [] });

/** Farda-authored text that names a prohibited inference is withheld; observed and quoted content passes unchanged. */
function screen(post: PostEvidence): { post: PostEvidence; quarantined: Quarantined[] } {
  const quarantined: Quarantined[] = [];
  const keep = (field: string, text: string) => {
    const reasonCodes = inferenceRefusals([text]);
    if (reasonCodes.length) quarantined.push({ postId: post.postId, field, reasonCodes });
    return !reasonCodes.length;
  };
  const review = { ...post.review, inferences: post.review.inferences.filter((text, i) => keep(`review.inferences[${i}]`, text)) };
  if (review.interruption && !keep("review.interruption.reason", review.interruption.reason))
    review.interruption = { ...review.interruption, reason: WITHHELD_INTERRUPTION };
  const context = post.context && { ...post.context, secondaryLabels: post.context.secondaryLabels.filter((text, i) => keep(`context.secondaryLabels[${i}]`, text)) };
  const productionChoices = post.productionChoices?.filter((choice, i) => keep(`productionChoices[${i}].observation`, choice.observation));
  return { post: { ...post, review, context, productionChoices }, quarantined };
}

/** Facts only: observation and receipt times move on every read and never make a repeated identical read a new version. */
export function evidenceFacts(packet: EvidencePacket) {
  const { evidenceRevision: _revision, collection, ...rest } = packet;
  void _revision;
  return {
    ...rest,
    posts: packet.posts.map(({ observedAt: _observed, source, accessObservation, metrics, comments, ...post }) => {
      void _observed;
      return { ...post, accessState: accessObservation?.state ?? null,
        source: source && { ...source, retrievedAt: null, permissionCheckedAt: null, evidenceRefs: null },
        metrics: metrics?.map(({ observedAt: _at, ...metric }) => { void _at; return metric; }),
        comments: comments.status === "observed" ? { ...comments, observedAt: null } : comments };
    }),
    collection: collection && { ...collection, observedAt: null, sourceReceiptRef: null,
      exclusions: collection.exclusions.map(({ observedAt: _at, ...entry }) => { void _at; return entry; }) },
  };
}
const reviewedFacts = (packet: EvidencePacket | null) => digest((packet?.posts ?? []).map(post => [post.postId, post.relevant, post.nativeLikes,
  post.review, post.context ?? null, post.accessObservation?.state ?? null]));

export type CollectedPacket = { packet: EvidencePacket; changed: boolean; quarantined: number };

/**
 * Merges one bounded source page into the latest stored packet. Prior evidence is never edited: posts the page did not
 * touch are carried as stored, and every change becomes a new immutable revision through the shared writer.
 */
export function buildCollectedPacket(input: { creatorId: string; prior: EvidencePacket | null; snapshot: VideoEvidenceSnapshot;
  collector: { version: string; stage: "synthetic-fixture" | "source" }; protect(packet: EvidencePacket): EvidencePacket }): CollectedPacket {
  const { creatorId, snapshot } = input;
  // A different brief or checkout route starts a new evidence basis; nothing brief-specific is carried across.
  const prior = input.prior && input.prior.briefId === snapshot.brief.ref && input.prior.checkoutRoute === snapshot.brief.checkoutRoute ? input.prior : null;
  const priorPosts = new Map((prior?.posts ?? []).map(post => [post.postId, post]));
  const priorRecent = new Map((prior?.recentPosts ?? []).map(post => [post.postId, post]));
  const posts = new Map(priorPosts), recent = new Map(priorRecent);
  const exclusions = new Map((prior?.collection?.exclusions ?? []).map(entry => [entry.postId, entry]));
  const quarantined = new Map<string, Quarantined[]>();
  for (const entry of prior?.collection?.quarantined ?? []) quarantined.set(entry.postId, [...quarantined.get(entry.postId) ?? [], entry]);
  const touched = new Set<string>();
  for (const observed of snapshot.posts) {
    const postId = j20PostId(creatorId, observed);
    if (touched.has(postId)) throw new Error("J20_DUPLICATE_SOURCE_POST");
    touched.add(postId);
    posts.delete(postId); exclusions.delete(postId); quarantined.delete(postId);
    const previous = priorPosts.get(postId);
    const access = { state: ACCESS[observed.access], sourceRef: observed.evidenceRefs[0] ?? observed.permissionRef, observedAt: observed.retrievedAt };
    if (observed.access !== "permitted") {
      // Access failures keep the earlier observation and record the failure beside it; nothing is re-observed or invented.
      if (previous?.source) posts.set(postId, { ...previous, review: withPlaybackFacts(previous.review), accessObservation: access,
        source: { ...previous.source, change: observed.access === "removed" ? "removed" : previous.source.change === "removed" ? "unchanged" : previous.source.change } });
      else exclusions.set(postId, { postId, reasons: [ACCESS_EXCLUSION[observed.access]], observedAt: observed.retrievedAt });
      continue;
    }
    const nativeLikes = nativeLikesOf(observed.likes);
    const gate = likeGate({ nativeLikes } as PostEvidence);
    const canonicalMediaId = observed.canonicalMediaRef ?? `media-${digest(nativePostIdentity(observed)).slice(0, 32)}`;
    const reasons: Exclusion[] = [];
    if (gate === "fail") reasons.push("LIKES_NOT_ABOVE_200");
    if (gate === "unknown") reasons.push("LIKES_PENDING_PROOF");
    if (observed.context.exclusion) reasons.push(CONTEXT_EXCLUSION[observed.context.exclusion]);
    if (observed.context.primaryBucket === "unknown") reasons.push("CONTEXT_UNKNOWN");
    else if (!APPROVED_LIFESTYLE_BUCKETS.includes(observed.context.primaryBucket)) reasons.push("CONTEXT_NOT_LIFESTYLE");
    if (!observed.relevant) reasons.push("NOT_RELEVANT_TO_BRIEF");
    const relevant = !reasons.some(reason => reason !== "LIKES_NOT_ABOVE_200" && reason !== "LIKES_PENDING_PROOF");
    const views = observed.metrics.find(metric => metric.key === "views");
    // Every accessible post, including ordinary lower-like posts, feeds the recent metadata baseline without deep-review credit.
    recent.set(postId, { postId, canonicalMediaId, publishedAt: observed.publishedAt, relevant, pinned: observed.context.pinned, nativeLikes,
      paid: observed.context.paid,
      views: views && views.value !== null ? { status: "known", value: views.value, definition: views.definition, window: views.window }
        : { status: views?.missingReason === "hidden" || views?.missingReason === "notAuthorized" ? "unavailable" : "unknown",
          reason: `Views ${views?.missingReason ?? "notCollected"}.` } } satisfies RecentPostMetadata);
    if (reasons.length) {
      if (observed.review && observed.review.status !== "unassessed" && gate !== "pass") reasons.push("REVIEW_IGNORED_BELOW_GATE");
      exclusions.set(postId, { postId, reasons, observedAt: observed.retrievedAt });
      continue;
    }
    const edited = !!previous?.source && previous.source.contentFingerprint !== null && observed.contentFingerprint !== null &&
      previous.source.contentFingerprint !== observed.contentFingerprint;
    // The change label describes this version against the one before it; an identical re-read keeps the stored label.
    const change = !previous?.source ? "firstObserved" as const : edited ? "changed" as const
      : previous.source.change === "removed" ? "unchanged" as const : previous.source.change;
    // A post that was not re-opened keeps its earlier review only while its content is the same footage.
    const review = observed.review ?? (previous && !edited ? withPlaybackFacts(previous.review) : unopened());
    const built: PostEvidence = { postId, canonicalMediaId, network: observed.network, sourceUrl: observed.sourceUrl, accessObservation: access,
      publishedAt: observed.publishedAt, observedAt: observed.retrievedAt, relevant: true, nativeLikes, review, comments: observed.comments,
      source: { route: observed.route, providerAccountRef: observed.providerAccount, permissionRef: observed.permissionRef,
        permissionCheckedAt: observed.permissionCheckedAt, retrievedAt: observed.retrievedAt, contentFingerprint: observed.contentFingerprint,
        change, evidenceRefs: observed.evidenceRefs },
      context: observed.context, metrics: observed.metrics, productionChoices: observed.productionChoices, shoppableContext: observed.shoppableContext };
    const screened = screen(built);
    posts.set(postId, screened.post);
    if (screened.quarantined.length) quarantined.set(postId, screened.quarantined);
  }
  const byDate = (a: { publishedAt: string | null; postId: string }, b: { publishedAt: string | null; postId: string }) =>
    (b.publishedAt ? Date.parse(b.publishedAt) : -Infinity) - (a.publishedAt ? Date.parse(a.publishedAt) : -Infinity) || a.postId.localeCompare(b.postId);
  const collection: EvidenceCollection = {
    schemaVersion: VIDEO_EVIDENCE_SCHEMA_VERSION, collectorVersion: input.collector.version, collectorStage: input.collector.stage,
    samplingPolicyVersion: J20_SAMPLING_POLICY_VERSION, taxonomyVersion: J20_TAXONOMY_VERSION, briefVersion: snapshot.brief.version,
    sourceReceiptRef: snapshot.receiptRef, observedAt: snapshot.observedAt,
    listedPosts: snapshot.listedPosts ?? prior?.collection?.listedPosts ?? null,
    exclusions: [...exclusions.values()].sort((a, b) => a.postId.localeCompare(b.postId)).slice(0, 200),
    audience: snapshot.audience.length ? snapshot.audience : prior?.collection?.audience ?? [],
    quarantined: [...quarantined.values()].flat().slice(0, 100),
  };
  const draft = {
    creatorId, briefId: snapshot.brief.ref, checkoutRoute: snapshot.brief.checkoutRoute, evidenceRevision: "j20-pending",
    termsRevision: prior?.termsRevision ?? "terms-unknown",
    posts: [...posts.values()].map(post => ({ ...post, review: withPlaybackFacts(post.review) })).sort(byDate).slice(0, 50),
    recentPosts: [...recent.values()].sort(byDate).slice(0, 100),
    ratings: { routine: null, demo: null }, criterionRatings: prior?.criterionRatings ?? {}, criterionEvidenceRefs: prior?.criterionEvidenceRefs ?? {},
    invitationGates: prior?.invitationGates ?? [], activationGates: prior?.activationGates ?? [], collection,
  };
  // Reviewer creative ratings stay attached only while the reviewed footage they rated is unchanged; otherwise they return to unknown.
  const candidate = input.protect(evidencePacketSchema.parse(draft));
  if (prior && reviewedFacts(input.protect(prior)) === reviewedFacts(candidate)) candidate.ratings = prior.ratings;
  const packet = evidencePacketSchema.parse({ ...candidate, evidenceRevision: `j20-${digest(evidenceFacts(candidate)).slice(0, 32)}` });
  const changed = !input.prior || digest(evidenceFacts(input.protect(input.prior))) !== digest(evidenceFacts(packet));
  return { packet, changed, quarantined: collection.quarantined.length };
}
