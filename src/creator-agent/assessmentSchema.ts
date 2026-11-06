import { z } from "zod";
import { routeAssessmentSchema } from "./routeEvidence.ts";

export const POLICY_VERSION = "2026-11-04";
export const AGENT_VERSION = "1.1.0";
export const AGENT_SCHEMA_VERSION = "creator-agent.v1";
const text = z.string().min(1);
const nullableText = text.nullable();
export const gateSchema = z.object({ id: text, state: z.enum(["pass", "fail", "unknown"]), reason: text }).strict();

/** A server-owned decision. There is no writable eligibility flag in the evidence input. */
const assessmentShapeSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  policyVersion: z.literal(POLICY_VERSION),
  agentVersion: z.enum(["1.0.0", AGENT_VERSION]),
  creatorId: text,
  briefId: text,
  evidenceRevision: text,
  termsRevision: text,
  modelId: z.enum(["WEBSITE-AFFILIATE-v3", "TIKTOK-SHOP-AFFILIATE-v3"]),
  config: z.object({ status: z.enum(["bound", "unbound"]), version: nullableText, hash: nullableText, baselineHash: nullableText, numericHash: nullableText }).strict(),
  configuration: z.object({
    criteria: z.array(z.object({ id: text, label: text, weight: z.number().finite().positive(), rating: z.number().int().min(0).max(5).nullable() }).strict()),
    bands: z.array(z.object({ id: text, min: z.number().finite() }).strict()),
    arithmetic: text,
  }).strict().nullable().optional(),
  state: z.enum(["reviewNeeded", "hold", "prospectiveInviteEligible", "activationReady"]),
  contentQualification: z.enum(["pass", "hold", "reviewNeeded"]),
  gates: z.array(gateSchema),
  packet: z.object({ qualifyingPosts: z.number().int().nonnegative(), publicationDates: z.number().int().nonnegative(), meaningfulUsePosts: z.number().int().nonnegative(), postIds: z.array(text) }).strict(),
  criteria: z.object({ routine: z.number().int().min(0).max(5).nullable(), demo: z.number().int().min(0).max(5).nullable() }).strict(),
  score: z.object({ earned: z.number(), max: z.number(), total: z.number().nullable(), unknownCount: z.number().int().nonnegative(), band: nullableText }).strict().nullable(),
  metadata: z.object({ sampleSize: z.number().int().nonnegative(), coverage: z.enum(["complete", "partial"]), reasonCodes: z.array(text), postIds: z.array(text), medianViews: z.number().nullable(), minViews: z.number().nullable(), maxViews: z.number().nullable(), comparableViewCount: z.number().int().nonnegative() }).strict(),
  comments: z.array(z.object({ postId: text, status: z.enum(["observed", "unknown", "unavailable"]), rowCount: z.number().int().nonnegative().nullable(), uniqueAuthors: z.number().int().nonnegative().nullable(), unknownAuthorRows: z.number().int().nonnegative().nullable(), promptedRows: z.number().int().nonnegative().nullable(), creatorRows: z.number().int().nonnegative().nullable(), promotionalRows: z.number().int().nonnegative().nullable(), categoryCounts: z.record(z.number().int().nonnegative()).nullable(), ordering: nullableText, reason: nullableText }).strict()),
  reviews: z.array(z.object({ postId: text, status: text, visualMethod: text, audioMethod: text, sampledPointCount: z.number().int().nonnegative(), continuousSeconds: z.number().nonnegative(), likeGate: z.enum(["pass", "fail", "unknown"]) }).strict()),
  routeEvidence: routeAssessmentSchema.optional(),
  reasonCodes: z.array(text),
}).strict();
export type CreatorAssessment = z.infer<typeof assessmentShapeSchema>;
// Widen the schema interface at the module boundary to avoid repeatedly expanding its nested implementation type.
export const creatorAssessmentSchema: z.ZodType<CreatorAssessment> = assessmentShapeSchema;
