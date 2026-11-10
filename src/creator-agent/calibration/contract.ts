import { z } from "zod";
import { ratingPolicy } from "../ratingPolicy.ts";

/**
 * Evidence-policy calibration contract. This mode may change only evidence-policy anchors and gates.
 * Numeric model identities, weights, arithmetic, bands and decision rules are out of scope and refused.
 */
export const CALIBRATION_SCHEMA_VERSION = "farda.calibration.v1";
export const CALIBRATION_MODE = "evidencePolicy";
export const BASELINE_VERSION_REF = "evidence-policy.2026-11-04.launch-v1";
export const CALIBRATION_ACTION_KIND = "calibration.promoteEvidencePolicy";
export const CRITERIA = ["routineFit", "demonstrationStorytelling", "verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"] as const;
export type CriterionId = (typeof CRITERIA)[number];

/** Owner-adjustable minimums for a confident proposal. Below them a proposal is only a provisional report. */
export const EVIDENCE_BASIS_MINIMUMS = { reviewedPackets: 20, distinctCreators: 10 } as const;
export const MAX_CHANGES = 20;
export const MAX_CANDIDATES = 25;
export const MAX_PROPOSAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export class CalibrationError extends Error {
  readonly code: string; readonly status: number; readonly reasonCodes: readonly string[];
  constructor(code: string, status = 409, reasonCodes: readonly string[] = []) {
    super(code); this.name = "CalibrationError"; this.code = code; this.status = status; this.reasonCodes = Object.freeze([...reasonCodes]);
  }
}

export const refSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !/^https?:/i.test(value), "Use an opaque reference.");
export const instantSchema = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "A finite timestamp is required.");
const text = z.string().trim().min(1).max(1_000);
const anchorText = z.string().trim().min(1).max(500);
const anchors = z.tuple([anchorText, anchorText, anchorText, anchorText, anchorText, anchorText]);
const floor = z.number().int().min(0).max(5);
const smallCount = z.number().int().min(0).max(50);

export const evidencePolicyConfigSchema = z.object({
  /** Native likes must be exact and strictly greater than this value. */
  likeGate: z.object({ minNativeLikesExclusive: z.number().int().min(0).max(1_000_000_000) }).strict(),
  /** The mandatory creator packet: independent reviewed posts, distinct publication dates and on-brief use examples. */
  packet: z.object({ minIndependentPosts: smallCount.min(1), minPublicationDates: smallCount.min(1), minMeaningfulUsePosts: smallCount }).strict(),
  /** Critical rating floors on the 0-5 rubric. They are evidence gates, not score weights. */
  criticalFloors: z.object({ routineFit: floor, demonstrationStorytelling: floor }).strict(),
  /** Reviewer rubric anchors for ratings 0-5. Changing text never re-rates saved evidence. */
  anchors: z.object(Object.fromEntries(CRITERIA.map(id => [id, anchors])) as Record<CriterionId, typeof anchors>).strict(),
}).strict().superRefine((config, ctx) => {
  if (config.packet.minPublicationDates > config.packet.minIndependentPosts)
    ctx.addIssue({ code: "custom", path: ["packet", "minPublicationDates"], message: "Distinct dates cannot exceed the required posts." });
  if (config.packet.minMeaningfulUsePosts > config.packet.minIndependentPosts)
    ctx.addIssue({ code: "custom", path: ["packet", "minMeaningfulUsePosts"], message: "Use examples cannot exceed the required posts." });
});
export type EvidencePolicyConfig = z.infer<typeof evidencePolicyConfigSchema>;

/**
 * The named immutable baseline. Gate values mirror the hard-coded launch gates in `policy.ts`
 * (a conformance test proves equality), and floors and anchors are read from `ratingPolicy`.
 */
export function baselineEvidencePolicy(): EvidencePolicyConfig {
  return evidencePolicyConfigSchema.parse({
    likeGate: { minNativeLikesExclusive: 200 },
    packet: { minIndependentPosts: 3, minPublicationDates: 2, minMeaningfulUsePosts: 2 },
    criticalFloors: { routineFit: ratingPolicy.criticalFloors.routineFit, demonstrationStorytelling: ratingPolicy.criticalFloors.demonstrationStorytelling },
    anchors: Object.fromEntries(CRITERIA.map(id => [id, [...ratingPolicy[id]]])),
  });
}

/** Every leaf a proposal may target in this mode. */
export const EVIDENCE_POLICY_PATHS: readonly string[] = Object.freeze([
  "likeGate.minNativeLikesExclusive",
  "packet.minIndependentPosts", "packet.minPublicationDates", "packet.minMeaningfulUsePosts",
  "criticalFloors.routineFit", "criticalFloors.demonstrationStorytelling",
  ...CRITERIA.flatMap(id => [0, 1, 2, 3, 4, 5].map(rating => `anchors.${id}.${rating}`)),
]);
/** Numeric model surfaces. A change set that names any of them is refused here, never partially applied. */
const NUMERIC_MODEL_ROOTS = ["modelId", "criteria", "weights", "weight", "bands", "arithmetic", "decisionRules", "numericBindings", "routineCriterionId", "demoCriterionId", "score"];
export type ChangeClass = "evidencePolicy" | "numericModel" | "unknown";
export function classifyPath(path: string): ChangeClass {
  if (EVIDENCE_POLICY_PATHS.includes(path)) return "evidencePolicy";
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  if (segments.some(segment => NUMERIC_MODEL_ROOTS.includes(segment))) return "numericModel";
  return "unknown";
}

/** Approved v3 numeric identity carried unchanged on every evidence-policy version. */
export const numericBindingSchema = z.object({ modelId: z.enum(["WEBSITE-AFFILIATE-v3", "TIKTOK-SHOP-AFFILIATE-v3"]), version: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/), numericHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type NumericBinding = z.infer<typeof numericBindingSchema>;

export const changeSchema = z.object({ path: z.string().min(1).max(120), before: z.unknown(), after: z.unknown(), rationale: text }).strict();
export type PolicyChange = { path: string; before: unknown; after: unknown; rationale: string };

const knownOrUnknown = z.discriminatedUnion("state", [
  z.object({ state: z.literal("known"), value: z.number().int().nonnegative().safe() }).strict(),
  z.object({ state: z.literal("unknown"), reason: text }).strict(),
]);
export type KnownOrUnknown = z.infer<typeof knownOrUnknown>;
/**
 * What the proposal is based on and where it stops. Only reviewed evidence records are an accepted basis.
 * There is deliberately no field for audience demographics, health or diagnosis, or sales outcomes.
 */
export const evidenceBasisSchema = z.object({
  kind: z.literal("reviewedEvidence"),
  basisRef: refSchema, basisVersion: refSchema,
  window: z.object({ from: instantSchema, to: instantSchema }).strict(),
  sourceKinds: z.array(z.enum(["completedPostReviews", "reviewerAnnotations", "gateOutcomes"])).min(1).max(3),
  reviewedPackets: knownOrUnknown, distinctCreators: knownOrUnknown, reviewerDisagreements: knownOrUnknown,
  /** Mature retained-sales cohorts are not available, so this mode can never claim them. */
  retainedSalesCohorts: z.object({ state: z.literal("unavailable"), reason: text }).strict(),
  limits: z.array(text).min(1).max(20),
}).strict();
export type EvidenceBasis = z.infer<typeof evidenceBasisSchema>;
export const rollbackBasisSchema = z.object({ kind: z.literal("rollback"), targetVersionRef: refSchema, reason: text, limits: z.array(text).min(1).max(20) }).strict();
export type RollbackBasis = z.infer<typeof rollbackBasisSchema>;

export const candidateSetSchema = z.object({
  setRef: refSchema, label: text,
  provenance: z.literal("synthetic"),
  /** The explicit cap the reviewer agreed to. A comparison never generalises beyond these rows. */
  limit: z.number().int().min(1).max(MAX_CANDIDATES),
  candidates: z.array(z.object({ candidateRef: refSchema, label: text, packet: z.unknown() }).strict()).min(1).max(MAX_CANDIDATES),
}).strict().superRefine((set, ctx) => {
  if (set.candidates.length > set.limit) ctx.addIssue({ code: "custom", path: ["candidates"], message: "The candidate set exceeds its declared limit." });
  if (new Set(set.candidates.map(c => c.candidateRef)).size !== set.candidates.length) ctx.addIssue({ code: "custom", path: ["candidates"], message: "Candidate refs must be unique." });
});
export type CandidateSetInput = z.input<typeof candidateSetSchema>;

export const proposalInputSchema = z.object({
  mode: z.literal(CALIBRATION_MODE),
  baseVersionRef: refSchema,
  rationale: text,
  changes: z.array(changeSchema).min(1).max(MAX_CHANGES),
  evidenceBasis: evidenceBasisSchema,
  candidateSet: candidateSetSchema,
  expiresAt: instantSchema,
}).strict();
export type ProposalInput = z.input<typeof proposalInputSchema>;
export const rollbackInputSchema = z.object({
  mode: z.literal(CALIBRATION_MODE),
  baseVersionRef: refSchema,
  basis: rollbackBasisSchema,
  candidateSet: candidateSetSchema,
  expiresAt: instantSchema,
}).strict();
export type RollbackInput = z.input<typeof rollbackInputSchema>;

export type GateState = "pass" | "fail" | "unknown";
export type Recommendation = "pass" | "hold" | "reviewNeeded";
export type GateResult = { id: string; state: GateState; reason: string };
export type CandidateComparison = { candidateRef: string; label: string; prior: Recommendation; proposed: Recommendation; changed: boolean;
  gateChanges: { id: string; before: GateResult; after: GateResult; drivenBy: string[] }[] };
export type ComparisonReport = {
  candidateSet: { setRef: string; label: string; provenance: "synthetic"; limit: number; candidateCount: number; hash: string };
  scope: "Synthetic, explicitly limited candidate set. Not a population estimate, not creator data, and not a sales or demographic inference.";
  numericScoring: "unchanged-not-evaluated";
  results: CandidateComparison[];
  anchorChanges: { path: string; reviewImpact: "humanReReviewRequired" }[];
  summary: { changed: number; unchanged: number; transitions: Record<string, number> };
};

export type Sufficiency =
  | { status: "sufficient"; minimums: typeof EVIDENCE_BASIS_MINIMUMS; observed: { reviewedPackets: number; distinctCreators: number } }
  | { status: "notRequired"; reason: "ROLLBACK_TO_APPROVED_VERSION" };

export type CalibrationProposal = {
  schemaVersion: typeof CALIBRATION_SCHEMA_VERSION; mode: typeof CALIBRATION_MODE; kind: "change" | "rollback";
  proposalRef: string; scope: { workspaceId: string; accountId: string };
  baseVersionRef: string; baseConfigHash: string; rollbackTargetVersionRef: string | null;
  rationale: string; changes: PolicyChange[];
  evidenceBasis: EvidenceBasis | RollbackBasis; sufficiency: Sufficiency;
  comparison: ComparisonReport;
  proposedConfig: EvidencePolicyConfig; proposedConfigHash: string; numericBindingsHash: string;
  proposedBy: string; createdAt: string; expiresAt: string;
  proposalHash: string;
};

export type BlockedReport = { status: "blocked"; mode: "evidencePolicy" | "numericCalibration"; reasonCodes: string[]; detail: string[];
  numericModel: "unchanged" };
export type ProvisionalReport = { status: "provisional"; mode: "evidencePolicy"; reasonCodes: string[]; detail: string[];
  minimums: typeof EVIDENCE_BASIS_MINIMUMS; observed: { reviewedPackets: number | null; distinctCreators: number | null };
  /** The change set is echoed for discussion only. It is not stored as a proposal and cannot be approved or promoted. */
  changes: PolicyChange[]; promotable: false };
export type RefusedReport = { status: "refused"; mode: "evidencePolicy"; reasonCodes: string[]; detail: string[] };

export type VersionOrigin =
  | { kind: "baseline"; source: "policy.ts launch gates and ratingPolicy anchors"; policyVersion: string }
  | { kind: "promotion"; proposalRef: string; proposalHash: string; proposalKind: "change" | "rollback"; rollbackOf: string | null;
      approval: { approvalRef: string; manifestVersion: number; manifestHash: string; receiptRef: string; principalRef: string; personRef: string; decidedAt: string; verificationRef: string } };
export type ConfigVersion = { schemaVersion: typeof CALIBRATION_SCHEMA_VERSION; versionRef: string; seq: number; parentVersionRef: string | null;
  config: EvidencePolicyConfig; configHash: string; numericBindings: NumericBinding[]; numericBindingsHash: string; origin: VersionOrigin; createdAt: string };

export type ProposalEvent =
  | { kind: "promoted"; at: string; versionRef: string; approvalRef: string; receiptRef: string; principalRef: string; personRef: string }
  | { kind: "rejected" | "withdrawn"; at: string; approvalRef: string; manifestVersion: number; receiptRef: string; principalRef: string; personRef: string; decidedAt: string }
  | { kind: "expired"; at: string; expiresAt: string };
export type ProposalState = "open" | "stale" | "promoted" | "rejected" | "withdrawn" | "expired";
export type ProposalRead = { proposal: CalibrationProposal; events: ProposalEvent[]; state: ProposalState };
export type PromotionReceipt = { status: "promoted"; versionRef: string; seq: number; parentVersionRef: string; configHash: string; proposalRef: string;
  approval: Extract<VersionOrigin, { kind: "promotion" }>["approval"]; promotedAt: string };
