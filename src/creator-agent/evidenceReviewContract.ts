import { z } from "zod";

const ref = z.string().min(1).max(240);
const second = z.number().finite().min(0).max(86400);
const basis = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewVersion = z.string().regex(/^er-[a-f0-9]{64}-[0-9]+$/);
export const accessObservation = z.object({
  state: z.enum(["permitted", "loginRequired", "permissionDenied", "unavailable", "deleted"]),
  sourceRef: ref, observedAt: z.string().datetime({ offset: true }).refine(t => Number.isFinite(Date.parse(t))),
}).strict();
const target = z.object({ id: ref, label: z.string().min(1).max(4000) }).strict();
const observationFields = z.object({
  category: z.enum(["hook", "demonstration", "framing", "audio"]), startSec: second, endSec: second, text: z.string().trim().min(1).max(500),
}).strict().refine(note => note.endSec > note.startSec, "The end must follow the start.");
const identity = { creatorId: ref, runId: z.string().uuid(), basisHash: basis, intentId: z.string().uuid().optional() };
export const reviewInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("observation"), note: observationFields }).strict(),
  z.object({ ...identity, kind: z.literal("disagree"), targetId: ref, reason: z.string().trim().min(12).max(500) }).strict(),
  z.object({ ...identity, kind: z.literal("override"), targetId: ref, reason: z.string().trim().min(12).max(500),
    replacement: z.string().trim().min(1).max(500) }).strict(),
]);
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export const evidenceAnnotation = z.object({
  id: z.string().uuid(), postId: ref.optional(), revision: z.number().int().positive(), reviewer: ref, recordedAt: z.string().datetime(),
  input: reviewInputSchema, original: target.nullable(),
}).strict();
export const sourceReviewSchema = z.object({
  runId: z.string().uuid(), creatorId: ref, postId: ref, canonicalMediaId: ref, nativeIdentity: ref,
  basisHash: basis, evidenceRevision: ref, termsRevision: ref, policyVersion: ref, modelId: ref, configHash: z.string().nullable(),
  superseded: z.boolean(), stale: z.boolean(), contested: z.boolean(), access: accessObservation.nullable(), recordedAt: z.string().datetime(),
  olderRunId: z.string().uuid().nullable(), newerRunId: z.string().uuid().nullable(),
  targets: z.array(target).max(1101), annotations: z.array(evidenceAnnotation).max(100),
}).strict();
export type SourceReview = z.infer<typeof sourceReviewSchema>;
export type EvidenceAnnotation = z.infer<typeof evidenceAnnotation>;
