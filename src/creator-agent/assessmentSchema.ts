import { z } from "zod";
import { routeAssessmentSchema } from "./routeEvidence.ts";
import { metricFeatureSchema } from "./metricCompatibility.ts";
import { assessmentNextActionSchema } from "./assessmentHandoff.ts";

export const POLICY_VERSION = "2026-11-04";
export const AGENT_VERSION = "1.3.0";
export const AGENT_SCHEMA_VERSION = "creator-agent.v1";
const text = z.string().min(1);
const nullableText = text.nullable();
const instant = z.string().datetime({ offset: true });
export const gateSchema = z.object({ id: text, state: z.enum(["pass", "fail", "unknown"]), reason: text }).strict();

/** Reviewer challenges from the existing annotation owner, copied with the versions they were recorded against. */
export const reviewerOverrideSchema = z.object({
  annotationRef: z.string().uuid(), kind: z.enum(["override", "disagree"]), postId: nullableText, targetRef: text, targetLabel: nullableText,
  reason: text, replacement: nullableText, reviewerRef: text, recordedAt: instant,
  basis: z.object({ revision: z.number().int().positive(), evidenceRevision: text, termsRevision: text, policyVersion: text, modelId: text,
    configHash: nullableText, agentVersion: text, rubricVersion: nullableText }).strict(),
}).strict();
export type ReviewerOverride = z.infer<typeof reviewerOverrideSchema>;
export const rescoreTriggerSchema = z.enum(["initial", "evidenceReady", "objectiveChange", "candidateChange", "offerChange", "staleEvidence", "policyChange",
  "reviewerOverride", "reviewerDisposition", "explicitRescore"]);
const j11Unavailable = z.object({ state: z.literal("unavailable"), reason: z.literal("J11_RETAINED_SALES_LEDGER_NOT_CONNECTED") }).strict();
export const REVIEWER_OVERRIDE_LIMIT = 100;
const calibrationStates = ["draft", "provisional", "heldOutEvaluated", "approvedCalibrated"] as const;
/**
 * Approved operating policy and empirical sales calibration are separate claims; only held-out mature outcomes can raise
 * the latter. `retired` records the end of a bound configuration and names the recordable state it followed: only
 * `provisional` can be recorded today, because held-out states need evidence this schema cannot attach and a draft has
 * no bound configuration to retire.
 */
const calibrationSchema = z.object({
  operatingPolicy: z.object({ status: z.enum(["approvedOperatingPolicy", "configurationUnbound"]), policyVersion: text, rubricVersion: text, configVersion: nullableText }).strict(),
  salesPrediction: z.object({ status: z.literal("unvalidated"), reason: z.literal("HELD_OUT_MATURE_OUTCOMES_NOT_ATTACHED") }).strict(),
  heldOutEvaluationRef: z.null(),
  retiredFrom: z.literal("provisional").nullable(),
}).strict();
const j02Fields = {
  rubricVersion: text.optional(),
  offer: z.discriminatedUnion("state", [
    z.object({ state: z.literal("bound"), origin: z.enum(["provider", "saved-offer"]), version: text, manifestHash: text }).strict(),
    z.object({ state: z.literal("none"), reason: z.enum(["SOURCE_PROOF_UNAVAILABLE", "NO_ACCEPTED_TERMS", "ACCEPTED_OFFER_MISSING_OR_CHANGED"]) }).strict(),
  ]).optional(),
  /** Known points with unknown criteria at 0 and at 5. Bounds are not imputation and never drive a decision. */
  scoreBounds: z.object({ min: z.number().nullable(), max: z.number().nullable(), total: z.number().nullable() }).strict()
    .refine(b => (b.min === null) === (b.max === null) && (b.min === null || b.min <= b.max!) && (b.total === null || b.min !== null), "Bounds must be ordered.").optional(),
  calibrationState: z.enum([...calibrationStates, "retired"]).optional(),
  calibration: calibrationSchema.optional(),
  metricCompatibility: z.array(metricFeatureSchema).max(3).optional(),
  /** The first 100 open challenges in their deterministic order; `reviewerOverrideCount` is the full number. */
  reviewerOverrides: z.array(reviewerOverrideSchema).max(REVIEWER_OVERRIDE_LIMIT).optional(),
  reviewerOverrideCount: z.number().int().nonnegative().safe().optional(),
  /** Creative fit, commerce evidence, confidence and financial readiness stay separate; none substitutes for another. */
  dimensions: z.object({ creativeFit: z.enum(["pass", "hold", "reviewNeeded"]), commerceEvidence: z.enum(["verified", "incompatible", "unverified", "unavailable"]),
    confidence: z.enum(["complete", "partial", "unknown"]), financialReadiness: z.literal("unavailable") }).strict().optional(),
  /** Creator Offer Economics v1 awaits owner approval and the J11 ledger; it is never applied as policy here and GMV never fills contribution. */
  economics: z.object({
    policy: z.object({ ref: z.literal("CEO-v1"), status: z.literal("pendingOwnerApproval"), appliedAsPolicy: z.literal(false) }).strict(),
    ledger: z.object({ owner: z.literal("J11"), state: z.literal("notConnected") }).strict(),
    fields: z.object({ retainedNetMerchandise: j11Unavailable, retainedOrders: j11Unavailable, retainedUnits: j11Unavailable, bundleMix: j11Unavailable,
      returns: j11Unavailable, contributionAfterCosts: j11Unavailable, acquisitionPayback: j11Unavailable, rewardProgress: j11Unavailable, rewardLiability: j11Unavailable }).strict(),
  }).strict().optional(),
  nextAction: assessmentNextActionSchema.optional(),
  /** Why this run happened, classified by the evidence writer from the stored prior run. Null only for a direct engine call that the writer did not make. */
  rescore: z.object({ triggers: z.array(rescoreTriggerSchema).min(1).max(rescoreTriggerSchema.options.length), priorRevision: z.number().int().positive().nullable() }).strict().nullable().optional(),
};
/** Fields every snapshot written by this agent version carries. Earlier versions never had them. */
export const J02_SNAPSHOT_FIELDS = Object.keys(j02Fields) as (keyof typeof j02Fields)[];

/** A server-owned decision. There is no writable eligibility flag in the evidence input. */
const assessmentShapeSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  policyVersion: z.literal(POLICY_VERSION),
  agentVersion: z.enum(["1.0.0", "1.1.0", "1.2.0", AGENT_VERSION]),
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
  ...j02Fields,
}).strict();
export type CreatorAssessment = z.infer<typeof assessmentShapeSchema>;
// Widen the schema interface at the module boundary to avoid repeatedly expanding its nested implementation type.
// Earlier agent versions remain parseable without these fields; a current snapshot must carry every one.
export const creatorAssessmentSchema: z.ZodType<CreatorAssessment> = assessmentShapeSchema.superRefine((a, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (a.agentVersion === AGENT_VERSION) for (const key of J02_SNAPSHOT_FIELDS)
    if (a[key] === undefined) fail(key, "A current J02 snapshot records every version, bound, override, calibration and handoff field.");
  // The rules below apply to whichever fields are present, whatever the agent version.
  if (a.calibrationState === "heldOutEvaluated" || a.calibrationState === "approvedCalibrated")
    fail("calibrationState", "Held-out or calibrated states require attached held-out mature-outcome evidence.");
  if (a.calibration && (a.calibrationState === "retired") !== (a.calibration.retiredFrom !== null))
    fail("calibrationState", "A retired configuration names the state it followed; no other state has one.");
  if (a.calibrationState === "retired" && a.calibration?.operatingPolicy.status !== "approvedOperatingPolicy")
    fail("calibrationState", "Only a bound configuration can be retired.");
  if (a.calibrationState && a.calibrationState !== "retired" && a.calibration && (a.calibrationState === "provisional") !== (a.calibration.operatingPolicy.status === "approvedOperatingPolicy"))
    fail("calibrationState", "Provisional means a bound approved operating policy; draft means no bound configuration.");
  if (a.reviewerOverrides && a.reviewerOverrideCount !== undefined && (a.reviewerOverrideCount < a.reviewerOverrides.length
    || (a.reviewerOverrideCount > a.reviewerOverrides.length && a.reviewerOverrides.length !== REVIEWER_OVERRIDE_LIMIT)))
    fail("reviewerOverrideCount", "The count covers every open challenge; only a full list of the first 100 may leave some unlisted.");
  const open = (a.reviewerOverrideCount ?? a.reviewerOverrides?.length ?? 0) > 0 && a.state !== "hold";
  if (open && !a.reasonCodes.includes("REVIEWER_OVERRIDE_OPEN")) fail("reasonCodes", "An open reviewer challenge is a recorded blocker.");
  if (a.nextAction && a.nextAction.recommendation !== (open ? "reviewNeeded" : a.state))
    fail("nextAction", "The handoff carries the snapshot's own recommendation, and review while a reviewer challenge is open.");
});
