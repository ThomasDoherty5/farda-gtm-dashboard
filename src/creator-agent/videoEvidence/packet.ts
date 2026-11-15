import { digest } from "../config.ts";
import {
  J20_SAMPLING_POLICY_VERSION, J20_TAXONOMY_VERSION, VIDEO_EVIDENCE_SCHEMA_VERSION, evidencePacketSchema, postEvidenceSchema,
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
/**
 * Reviewer creative ratings describe the footage of the posts that were rated. They carry only while every rated post is still
 * present with the same confirmed footage (a known, equal fingerprint) and the same review. A like-count change or a newly
 * found post does not reset them; a missing fingerprint is unknown footage, never unchanged.
 */
function ratedFootageUnchanged(prior: EvidencePacket, next: EvidencePacket) {
  const current = new Map(next.posts.map(post => [post.postId, post]));
  return prior.posts.every(rated => {
    const now = current.get(rated.postId);
    const before = rated.source?.contentFingerprint ?? null, after = now?.source?.contentFingerprint ?? null;
    return !!now && before !== null && before === after && digest(rated.review) === digest(now.review);
  });
}

/** Source-supplied content that cannot form a valid post. The runtime reports it as a source response error. */
export class J20SourceDataError extends Error {}
/** An internal merge that cannot form a valid packet. The runtime holds it for an owner; it is never blamed on the source. */
export class J20MergeError extends Error {}
export const j20ReviewerRef = (collectorVersion: string) => `agent:j20-video-evidence.v1/${collectorVersion}`;

export type CollectedPacket = { packet: EvidencePacket; changed: boolean; quarantined: number };

/**
 * Merges one bounded source page into the latest stored packet. Prior evidence is never edited: posts the page did not
 * touch are carried as stored, and every change becomes a new immutable revision through the shared writer.
 */
export function buildCollectedPacket(input: { creatorId: string; prior: EvidencePacket | null; snapshot: VideoEvidenceSnapshot;
  collector: { version: string; stage: "synthetic-fixture" | "source" }; protect(packet: EvidencePacket): EvidencePacket }): CollectedPacket {
  const { creatorId, snapshot } = input;
  // Brief, brief version and checkout route define the evidence basis. A different basis carries nothing.
  const sameBasis = !!input.prior && input.prior.briefId === snapshot.brief.ref && input.prior.checkoutRoute === snapshot.brief.checkoutRoute &&
    (!input.prior.collection || input.prior.collection.briefVersion === snapshot.brief.version);
  // Reviewer-entered posts are not J20 observations: a collected packet starts its post set from J20 posts only, keeping the
  // reviewer's gates, terms and criterion ratings for the same brief and route.
  const prior = sameBasis ? input.prior : null;
  const collectedPrior = prior?.collection ? prior : null;
  const priorPosts = new Map((collectedPrior?.posts ?? []).map(post => [post.postId, post]));
  const priorRecent = new Map((collectedPrior?.recentPosts ?? []).map(post => [post.postId, post]));
  const posts = new Map(priorPosts), recent = new Map(priorRecent);
  const exclusions = new Map((collectedPrior?.collection?.exclusions ?? []).map(entry => [entry.postId, entry]));
  const quarantined = new Map<string, Quarantined[]>();
  for (const entry of collectedPrior?.collection?.quarantined ?? []) quarantined.set(entry.postId, [...quarantined.get(entry.postId) ?? [], entry]);
  const touched = new Set<string>();
  for (const observed of snapshot.posts) {
    const postId = j20PostId(creatorId, observed);
    if (touched.has(postId)) throw new J20SourceDataError("J20_DUPLICATE_SOURCE_POST");
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
    // J20-07: these three exclusions gate relevance. Bucket labels (including other and unknown) are recorded, not gating.
    if (observed.context.exclusion) reasons.push(CONTEXT_EXCLUSION[observed.context.exclusion]);
    if (!observed.relevant) reasons.push("NOT_RELEVANT_TO_BRIEF");
    const relevant = !reasons.some(reason => reason !== "LIKES_NOT_ABOVE_200" && reason !== "LIKES_PENDING_PROOF");
    const views = observed.metrics.find(metric => metric.key === "views");
    // Every accessible post, including ordinary lower-like posts, feeds the recent metadata baseline without deep-review credit.
    // A rounded view label is not an exact count, so it stays out of the comparable baseline.
    recent.set(postId, { postId, canonicalMediaId, publishedAt: observed.publishedAt, relevant, pinned: observed.context.pinned, nativeLikes,
      paid: observed.context.paid,
      views: views && views.value !== null && !views.approximate ? { status: "known", value: views.value, definition: views.definition, window: views.window }
        : views?.approximate ? { status: "unknown", reason: `Views shown only as the rounded label ${views.rawLabel}.` }
          : { status: views?.missingReason === "hidden" || views?.missingReason === "notAuthorized" ? "unavailable" : "unknown",
            reason: `Views ${views?.missingReason ?? "notCollected"}.` } } satisfies RecentPostMetadata);
    if (reasons.length) {
      if (observed.review && observed.review.status !== "unassessed" && gate !== "pass") reasons.push("REVIEW_IGNORED_BELOW_GATE");
      exclusions.set(postId, { postId, reasons, observedAt: observed.retrievedAt });
      continue;
    }
    const before = previous?.source?.contentFingerprint ?? null, after = observed.contentFingerprint;
    const confirmedSame = !!previous?.source && before !== null && after !== null && before === after;
    // The change label describes this version against the one before it; an identical re-read keeps the stored label.
    const change = !previous?.source ? "firstObserved" as const : before === null || after === null ? "unverified" as const
      : before !== after ? "changed" as const : previous.source.change === "removed" || previous.source.change === "unverified" ? "unchanged" as const : previous.source.change;
    // A post that was not re-opened keeps its earlier review only while its footage is confirmed to be the same.
    // The collector's own reviewer label is never stored: an agent review is always recorded as the agent.
    const review = observed.review ? { ...observed.review, reviewerRef: j20ReviewerRef(input.collector.version) }
      : confirmedSame && previous ? withPlaybackFacts(previous.review) : unopened();
    const built: PostEvidence = { postId, canonicalMediaId, network: observed.network, sourceUrl: observed.sourceUrl, accessObservation: access,
      publishedAt: observed.publishedAt, observedAt: observed.retrievedAt, relevant: true, nativeLikes, review, comments: observed.comments,
      source: { route: observed.route, providerAccountRef: observed.providerAccount, permissionRef: observed.permissionRef,
        permissionCheckedAt: observed.permissionCheckedAt, retrievedAt: observed.retrievedAt, contentFingerprint: observed.contentFingerprint,
        change, evidenceRefs: observed.evidenceRefs },
      context: observed.context, metrics: observed.metrics, productionChoices: observed.productionChoices, shoppableContext: observed.shoppableContext };
    const screened = screen(built);
    if (!postEvidenceSchema.safeParse(screened.post).success) throw new J20SourceDataError("J20_SOURCE_POST_INVALID");
    posts.set(postId, screened.post);
    if (screened.quarantined.length) quarantined.set(postId, screened.quarantined);
  }
  const byDate = (a: { publishedAt: string | null; postId: string }, b: { publishedAt: string | null; postId: string }) =>
    (b.publishedAt ? Date.parse(b.publishedAt) : -Infinity) - (a.publishedAt ? Date.parse(a.publishedAt) : -Infinity) || a.postId.localeCompare(b.postId);
  const collection: EvidenceCollection = {
    schemaVersion: VIDEO_EVIDENCE_SCHEMA_VERSION, collectorVersion: input.collector.version, collectorStage: input.collector.stage,
    samplingPolicyVersion: J20_SAMPLING_POLICY_VERSION, taxonomyVersion: J20_TAXONOMY_VERSION, briefVersion: snapshot.brief.version,
    sourceReceiptRef: snapshot.receiptRef, observedAt: snapshot.observedAt,
    listedPosts: snapshot.listedPosts ?? collectedPrior?.collection?.listedPosts ?? null,
    ...(snapshot.policyWindow ? { policyWindow: snapshot.policyWindow } : collectedPrior?.collection?.policyWindow ? { policyWindow: collectedPrior.collection.policyWindow } : {}),
    exclusions: [...exclusions.values()].sort((a, b) => a.postId.localeCompare(b.postId)).slice(0, 200),
    // A collector cannot verify audience proof; verified aggregate evidence comes only from the server-held route proof.
    audience: snapshot.audience.length ? snapshot.audience.map(entry => ({ ...entry, verified: false })) : collectedPrior?.collection?.audience ?? [],
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
  const parsed = evidencePacketSchema.safeParse(draft);
  if (!parsed.success) throw new J20MergeError("J20_PACKET_MERGE_INVALID");
  const candidate = input.protect(parsed.data);
  if (prior && ratedFootageUnchanged(input.protect(prior), candidate)) candidate.ratings = prior.ratings;
  const packet = evidencePacketSchema.parse({ ...candidate, evidenceRevision: `j20-${digest(evidenceFacts(candidate)).slice(0, 32)}` });
  const changed = !input.prior || digest(evidenceFacts(input.protect(input.prior))) !== digest(evidenceFacts(packet));
  return { packet, changed, quarantined: collection.quarantined.length };
}
