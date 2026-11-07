import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { assessmentBasisSchema, routeId, type AssessmentBasis, type OfferRecord } from "../offers/contract.ts";
import { offerPhaseSchema, type OfferPolicyProof } from "../offers/policy.ts";
import type { OfferRepository } from "../offers/repository.ts";
import { sameCommercialScope } from "./authority.ts";
import { commercialRef, commercialScopeSchema, type CommercialScope } from "./contract.ts";
import { commercialEligibilityReasonSchema, commercialEligibilityViewSchema, type CommercialEligibilityReason, type CommercialEligibilityView } from "./views.ts";

const contextSchema = z.object({ creatorId: commercialRef, offerId: routeId.optional(),
  offerVersion: z.string().regex(/^v[1-9]\d*$/).optional(), phase: offerPhaseSchema,
  assessment: assessmentBasisSchema.nullable().optional() }).strict();
export type CommercialProjectionContext = z.infer<typeof contextSchema>;
export type CommercialProjectionOptions = { offers: OfferRepository; db: DatabaseSync; scope: CommercialScope; secret: string; now?: () => number };
export type CommercialProjection = { data: CommercialEligibilityView; assertCurrent(): void };
export class CommercialProjectionError extends Error {
  readonly code: "COMMERCIAL_SCOPE_DENIED" | "COMMERCIAL_SELECTION_INVALID" | "COMMERCIAL_PROJECTION_CHANGED";
  readonly status: number;
  readonly executionCertainty = "notApplied" as const;
  constructor(code: CommercialProjectionError["code"], status: number) { super(code); this.name = "CommercialProjectionError"; this.code = code; this.status = status; }
}
const changed = (): never => { throw new CommercialProjectionError("COMMERCIAL_PROJECTION_CHANGED", 409); };
const denied = (): never => { throw new CommercialProjectionError("COMMERCIAL_SCOPE_DENIED", 403); };
const proofMaterial = (proof: OfferPolicyProof) => {
  const { observedAt, validUntil, ...material } = proof; void observedAt; void validUntil; return material;
};
const recordMaterial = (record: OfferRecord) => ({ offerId: record.offerId, version: record.version, revision: record.revision,
  manifestHash: record.manifestHash, creatorId: record.terms.creatorId, assessment: record.assessment,
  assessmentCurrent: record.assessmentCurrent, ownerApprovalRef: record.ownerApprovalRef, acceptedRef: record.acceptedRef,
  commercial: record.commercial ?? null });
const reason = (value: string): CommercialEligibilityReason => {
  const parsed = commercialEligibilityReasonSchema.safeParse(value); return parsed.success ? parsed.data : "COMMERCIAL_SOURCE_HELD";
};
function assessmentBasis(context: CommercialProjectionContext, record: OfferRecord): { status: CommercialEligibilityView["basisStatus"]; reasons: CommercialEligibilityReason[]; assessment: AssessmentBasis | null } {
  const supplied = context.assessment === undefined ? record.assessment : context.assessment;
  if (!supplied || !record.assessment) return { status: "missing", reasons: ["ASSESSMENT_BASIS_REQUIRED"], assessment: supplied };
  if (supplied.stale || !record.assessmentCurrent || record.assessment.stale)
    return { status: "stale", reasons: ["ASSESSMENT_BASIS_STALE"], assessment: supplied };
  if (digest(supplied) !== digest(record.assessment) || supplied.creatorId !== context.creatorId ||
    supplied.termsRevision !== record.manifestHash || !supplied.configHash)
    return { status: "mismatch", reasons: ["ASSESSMENT_BASIS_MISMATCH"], assessment: supplied };
  return { status: "current", reasons: [], assessment: supplied };
}

/** One read-only projection for all consumers; callers retain their own exact selection and final parent-source fence. */
export function createCommercialProjection(options: CommercialProjectionOptions) {
  const { offers, db } = options, scope = commercialScopeSchema.parse(structuredClone(options.scope)), now = options.now ?? Date.now;
  if (options.secret.length < 32) throw new Error("COMMERCIAL_PROJECTION_SECRET_REQUIRED");
  const secret = options.secret;
  function assertScope() {
    const actual = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (actual?.workspace_id !== scope.workspaceId || actual.account_id !== scope.accountId) denied();
  }
  assertScope();
  const hash = (purpose: string, value: unknown) => createHmac("sha256", secret).update(JSON.stringify({ purpose, scope, value })).digest("hex");
  const alias = (purpose: string, value: string) => `commercial-${purpose}-${hash(purpose, value)}`;
  function read(context: CommercialProjectionContext) {
    assertScope();
    const selected = context.offerId ? { offerRef: alias("offer", context.offerId), version: context.offerVersion ?? null } : null;
    const base: CommercialEligibilityView = { kind: "commercial-eligibility", selected, phase: context.phase, state: selected ? "held" : "unbound",
      reasonCodes: [], basisStatus: "notSelected", policyVersion: null, modelVersion: null, configVersion: null,
      rewardBasis: "unknown", rewardVersion: null, basisHash: null, confersApproval: false, sourceEffect: "none" };
    if (!context.offerId) return { data: { ...base, reasonCodes: ["OFFER_SELECTION_REQUIRED"] as CommercialEligibilityReason[] }, material: { selection: context }, proof: null };
    const record = offers.readOffer(context.offerId);
    if (record && record.terms.creatorId !== context.creatorId) denied();
    // Verify the selected record exists in this actual scoped database; never find an offer by creator or list order.
    const row = db.prepare("SELECT body FROM offer_versions WHERE offer_id=? ORDER BY revision DESC LIMIT 1").get(context.offerId);
    if (!!row !== !!record) denied();
    if (!record) return { data: { ...base, reasonCodes: ["OFFER_NOT_FOUND"] as CommercialEligibilityReason[] }, material: { selection: context, missing: true }, proof: null };
    const local: unknown = JSON.parse(String(row!.body));
    const anchor = z.object({ offerId: z.string(), version: z.string(), manifestHash: z.string(), terms: z.object({ creatorId: z.string() }) }).parse(local);
    if (anchor.offerId !== record.offerId || anchor.version !== record.version || anchor.manifestHash !== record.manifestHash || anchor.terms.creatorId !== record.terms.creatorId) denied();
    const material = recordMaterial(record);
    if (!context.offerVersion || context.offerVersion !== record.version) return { data: { ...base,
      reasonCodes: [context.offerVersion ? "OFFER_VERSION_MISMATCH" : "OFFER_VERSION_REQUIRED"] as CommercialEligibilityReason[] }, material: { selection: context, record: material }, proof: null };
    const basis = assessmentBasis(context, record), eligibility = offers.resolvePolicyProof(context.offerId, context.phase);
    const proof = eligibility?.proof ? structuredClone(eligibility.proof) : null;
    if (proof && (!sameCommercialScope(proof.scope, scope) || proof.offerId !== context.offerId || proof.offerVersion !== context.offerVersion ||
      proof.phase !== context.phase || proof.manifestHash !== record.manifestHash)) denied();
    const codes = [...new Set([...(eligibility?.reasonCodes ?? ["COMMERCIAL_SOURCE_HELD"]).map(reason), ...basis.reasons])];
    if (!proof && !codes.length) codes.push("COMMERCIAL_SOURCE_HELD");
    const stable = { selection: { creatorId: context.creatorId, offerId: context.offerId, offerVersion: context.offerVersion, phase: context.phase }, record: material, basis: basis.assessment,
      eligibility: eligibility ? { ...eligibility, proof: proof ? proofMaterial(proof) : null } : null };
    const data: CommercialEligibilityView = { ...base, state: proof && !codes.length ? "eligible" : "held", reasonCodes: codes, basisStatus: basis.status,
      policyVersion: proof ? alias("policy", proof.policyVersion) : null, modelVersion: proof ? alias("model", proof.modelVersion) : null,
      configVersion: proof ? alias("config", proof.configHash) : null,
      rewardBasis: proof ? proof.rewardVersion === null ? "notApplicable" : "verified" : "unknown",
      rewardVersion: proof?.rewardVersion ? alias("reward", proof.rewardVersion) : null, basisHash: proof ? hash("basis", stable) : null,
      ...(proof ? {validity:{observedAt:proof.observedAt,validUntil:proof.validUntil}} : {}) };
    return { data, material: stable, proof };
  }
  return {
    project(input: CommercialProjectionContext): CommercialProjection {
      const parsed = contextSchema.safeParse(structuredClone(input));
      if (!parsed.success) throw new CommercialProjectionError("COMMERCIAL_SELECTION_INVALID", 422);
      const context = parsed.data, captured = read(context), fingerprint = digest(captured.material);
      const assertCurrent = () => {
        const current = read(context);
        if (digest(current.material) !== fingerprint) changed();
        if (captured.proof) {
          try { offers.assertPolicyProof(structuredClone(captured.proof), now()); } catch { changed(); }
        }
        assertScope();
        if (captured.proof && !offers.matchesOfferVersion(context.offerId!, context.offerVersion!, captured.proof.manifestHash)) changed();
      };
      // The first read also closes source callbacks that changed the selection while resolving its proof.
      assertCurrent();
      return { data: commercialEligibilityViewSchema.parse(captured.data), assertCurrent };
    },
  };
}
