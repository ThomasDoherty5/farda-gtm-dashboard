import { z } from "zod";
import {
  audienceEvidenceSchema, commentsSchema, lifestyleContextSchema, metricMissingReasonSchema, postMetricSchema, productionChoiceSchema,
  reviewSchema, shoppableContextSchema, sourceRouteSchema,
} from "../evidence.ts";
import { runtimeInstant, runtimeRef, type RuntimeWindow } from "../jobs/runtimeSchema.ts";

/**
 * J20 collector contract. The collector observes; this module and the shared creator evidence writer decide what is stored.
 * Nothing a collector returns can assign a score, resolve a claim, choose a policy or send anything.
 */
export const J20_COLLECTOR_REQUEST_VERSION = "j20-collector-request.v1" as const;
const id = z.string().trim().min(1).max(240);
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const count = z.number().int().nonnegative().safe();

/** The like counter exactly as the source showed it. The J20 gate, not the collector, decides whether it is exact native evidence. */
export const likeObservationSchema = z.object({
  value: count.nullable(),
  rawLabel: z.string().trim().min(1).max(80).nullable(),
  sourceType: z.enum(["nativePublicCounter", "nativeReport", "authorizedExport", "thirdParty"]),
  sourceRef: id,
  missingReason: metricMissingReasonSchema.nullable(),
}).strict().refine(likes => (likes.value === null) === (likes.missingReason !== null), { message: "A missing like count needs its reason and no value." });
export type LikeObservation = z.infer<typeof likeObservationSchema>;

export const sourcePostSchema = z.object({
  network: z.enum(["instagram", "tiktok"]),
  /** The original public video address. The J20 record identity derives from its native post ID, never from a caller label. */
  sourceUrl: z.string().url().max(2_000),
  /** A source-held cross-post fingerprint when the same footage appears twice; null derives one from the native identity. */
  canonicalMediaRef: id.nullable(),
  publishedAt: runtimeInstant.nullable(),
  access: z.enum(["permitted", "removed", "loginRequired", "permissionDenied", "unavailable"]),
  route: sourceRouteSchema,
  /** Raw provider account reference. The writer replaces it with a scoped alias before anything is stored. */
  providerAccount: id.nullable(),
  permissionRef: id,
  permissionCheckedAt: runtimeInstant,
  retrievedAt: runtimeInstant,
  contentFingerprint: id.nullable(),
  evidenceRefs: z.array(id).max(50),
  relevant: z.boolean(),
  context: lifestyleContextSchema,
  likes: likeObservationSchema,
  metrics: z.array(postMetricSchema).max(20),
  /** Null when the post was not opened. A review offered for a post below the gate is never stored. */
  review: reviewSchema.nullable(),
  comments: commentsSchema,
  productionChoices: z.array(productionChoiceSchema).max(30),
  shoppableContext: shoppableContextSchema,
}).strict();
export type SourcePost = z.infer<typeof sourcePostSchema>;

export const videoEvidenceSnapshotSchema = z.object({
  receiptRef: runtimeRef,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: runtimeInstant,
  validUntil: runtimeInstant,
  /** The source's binding of the intake brief to its checkout route. It must name the exact queued brief and version. */
  brief: z.object({ ref: id, version: id, checkoutRoute: z.enum(["website", "tiktok-shop"]) }).strict(),
  listedPosts: count.max(10_000).nullable(),
  posts: z.array(sourcePostSchema).max(100),
  audience: z.array(audienceEvidenceSchema).max(20),
  nextCursor: runtimeRef.nullable(),
}).strict();
export type VideoEvidenceSnapshot = z.infer<typeof videoEvidenceSnapshotSchema>;

export const videoEvidenceReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("observed"), snapshot: videoEvidenceSnapshotSchema }).strict(),
  /** Login and MFA become the runtime's owned takeover. The collector never clicks through them. */
  z.object({ state: z.literal("takeover"), kind: z.enum(["login", "mfa"]), reasonCode: reason }).strict(),
  z.object({ state: z.literal("denied"), reasonCode: reason }).strict(),
  z.object({ state: z.literal("unavailable"), reasonCode: reason, retryAfterMs: z.number().int().min(0).max(3_600_000) }).strict(),
]);
export type VideoEvidenceRead = z.infer<typeof videoEvidenceReadSchema>;

export type VideoEvidenceRequest = {
  version: typeof J20_COLLECTOR_REQUEST_VERSION;
  scope: { workspaceId: string; accountId: string; environment: "sandbox" };
  creatorId: string;
  intakeRevision: number;
  briefRef: { ref: string; version: string };
  profiles: { network: "instagram" | "tiktok"; accountId: string; sourceId: string | null; url: string | null }[];
  cursor: string | null;
  maxRecords: number;
  route: "api" | "browser";
  window: RuntimeWindow;
  samplingPolicyVersion: string;
  taxonomyVersion: string;
};

/**
 * A trusted server-side collector. `stage` is reported in capabilities and on every stored packet: a synthetic fixture
 * collector is always `synthetic-fixture`, and only a separately qualified real collector may report `source`.
 */
export type VideoEvidenceSource = {
  readonly stage: "synthetic-fixture" | "source";
  readonly collectorVersion: string;
  read(request: VideoEvidenceRequest): Promise<unknown>;
  /** Synchronous final fence immediately before the evidence write. Throw when the source lease or permission changed. */
  assertCurrent(snapshot: VideoEvidenceSnapshot, request: VideoEvidenceRequest, now: number): void;
};
export type VideoEvidenceBinding = {
  /** An existing compiled daily J20 observe registration in the runtime registry. */
  registrationRef: string;
  /** The owned handoff a person uses for login or MFA; the runtime resumes only on a source-issued resolution receipt. */
  handoffRef: string;
  source: VideoEvidenceSource;
};
