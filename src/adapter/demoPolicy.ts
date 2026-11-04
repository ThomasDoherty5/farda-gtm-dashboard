import { z } from "zod";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "./contract";
import { AdapterError, type AdapterErrorBody } from "./errors";
import { BASE_POLICY, POLICY_BOUNDS, checkApprovedDispatch, evaluateTerms, fieldErrorsOf, routeCreatorReply, type AcquisitionTerms, type PolicyConfig, type UntrustedTerms } from "./commissionPolicy";
import { createOnce } from "./demoOnce";
import { DEMO_ACTOR_ROLE } from "@/fixtures/approvals";

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

export const POLICY_ACTIONS = ["createOffer", "editOffer", "importOffers", "dispatchOffer", "recordCreatorReply", "changeAcquisitionPolicy"] as const;
type PolicyAction = (typeof POLICY_ACTIONS)[number];

const termsSchema = z.object({
  relationship: z.string(),
  upfrontFeeMinor: z.number(),
  guaranteedFeeMinor: z.number(),
  paidComponentMinor: z.number(),
  commissionPct: z.number(),
  perSaleFixedMinor: z.number(),
  sampleCostMinor: z.number(),
});
const offerSchema = z.object({ offerId: z.string().min(1).optional(), terms: termsSchema });
const importSchema = z.object({ offers: z.array(offerSchema).min(1).max(500) });
const replySchema = z.object({ creatorRef: z.string().min(1), sourceRef: z.string().min(1), text: z.string() });
const policyChangeSchema = z
  .object({
    version: z.string().trim().min(1),
    maxCommissionPct: z.number().finite().gt(0).max(POLICY_BOUNDS.maxCommissionPct).optional(),
    sampleCapMinor: z.number().int().positive().max(POLICY_BOUNDS.sampleCapMinor).optional(),
  })
  .strict();

export type OfferPayload = z.infer<typeof offerSchema>;
export type ImportPayload = z.infer<typeof importSchema>;
export type ReplyPayload = z.infer<typeof replySchema>;
export type PolicyChangePayload = z.infer<typeof policyChangeSchema>;

/** Only a founder changes the acquisition policy (adapter decision D-5). The role is the demo actor's, never a client claim. */
const POLICY_AUTHORITY = "founder";
/** An offer the service has not stored yet starts at this version, as the seeded offer does. */
const FIRST_OFFER_VERSION = "v1";

/**
 * In-memory stand-in for server-side acquisition-policy enforcement. It validates the shape, re-evaluates the submitted
 * terms itself and trusts no client flag, so a manipulated payload is refused. Fixture evidence only: the authenticated
 * adapter (THO-283) must enforce the same rule. Nothing is sent, funded or reserved here.
 */
export function createDemoPolicy(opts: {
  /**
   * Terms of an approval, for the dispatch guard. Null means the approval is an accepted historical liability that is
   * paid as accepted. A throw, or undefined, means the terms can't be read, and the guard then refuses (fails closed).
   */
  termsOf?: (approvalRef: string) => AcquisitionTerms | null;
  actorRole?: string;
} = {}) {
  const actorRole = opts.actorRole ?? DEMO_ACTOR_ROLE;
  let policy: PolicyConfig = { ...BASE_POLICY };
  /** The policy an approval was made under. Anything unlisted was approved under the starting policy. */
  const approvedUnder = new Map<string, PolicyConfig>();
  const offerVersions = new Map<string, string>();
  const stats = { dispatches: 0, counterOffers: 0 };
  const replies: { creatorRef: string; state: string; reasonCodes: string[] }[] = [];
  const once = createOnce();

  const response = (request: ActionRequest<unknown>, state: ActionResponse["state"], reasonCodes: string[], receiptRefs: string[] = []): ActionResponse => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    actionRef: `demo-action-${request.idempotencyKey}`,
    state,
    runRef: null,
    approvalRef: request.approvalRef,
    manifestRef: null,
    payloadVersion: "policy-demo@1",
    policyVersion: policy.version,
    modelVersion: null,
    offerVersion: null,
    reasonCodes,
    receiptRefs,
    nextAction: state === "blocked" ? { kind: "reviewTermsMismatch", ownerRef: "Creator operations", dueAt: null, available: true } : null,
    nextPollAfterMs: null,
  });

  /** A payload of the wrong shape is a validation error naming the fields, never a thrown TypeError. */
  function parse<S extends z.ZodTypeAny>(schema: S, payload: unknown, rid: string): z.infer<S> {
    const parsed = schema.safeParse(payload);
    if (parsed.success) return parsed.data;
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".") || "payload"] ??= issue.message;
    return fail("VALIDATION_FAILED", "The request is malformed. Nothing was applied.", rid, { fieldErrors });
  }

  function requireEligible(terms: UntrustedTerms, rid: string, prefix = "") {
    const e = evaluateTerms(terms, policy);
    if (!e.eligible) fail("POLICY_VIOLATION", `Commission-only policy: ${e.blockers.map((b) => b.message).join(" ")}`, rid, { fieldErrors: fieldErrorsOf(e, prefix) });
  }

  function changePolicy(request: ActionRequest<unknown>): ActionResponse {
    const rid = request.requestId;
    if (actorRole !== POLICY_AUTHORITY)
      fail("FORBIDDEN", `AUTHORITY_REQUIRED: only a ${POLICY_AUTHORITY} can change the acquisition policy. Nothing was changed.`, rid, { fieldErrors: { authority: `Requires the ${POLICY_AUTHORITY} role.` } });
    const p = parse(policyChangeSchema, request.payload, rid);
    const version = p.version.trim();
    if (version === policy.version) fail("VALIDATION_FAILED", "A policy change needs a new version name.", rid, { fieldErrors: { version: "Use a version that is not the one in force." } });
    policy = { version, maxCommissionPct: p.maxCommissionPct ?? policy.maxCommissionPct, sampleCapMinor: p.sampleCapMinor ?? policy.sampleCapMinor };
    return response(request, "succeeded", ["POLICY_VERSION_CHANGED"]);
  }

  function apply(request: ActionRequest<unknown>): ActionResponse {
    const kind = request.actionKind as PolicyAction;
    const rid = request.requestId;
    if (kind === "changeAcquisitionPolicy") return changePolicy(request);
    if (kind === "recordCreatorReply") {
      const p = parse(replySchema, request.payload, rid);
      const route = routeCreatorReply(p.text, p.sourceRef);
      replies.push({ creatorRef: p.creatorRef, state: route.state, reasonCodes: route.reasonCodes });
      // A fee request holds the item for review. It never dispatches and never produces a counter-offer.
      return response(request, route.kind === "feeRequest" ? "blocked" : "succeeded", route.reasonCodes, [route.evidence.sourceRef]);
    }
    if (kind === "importOffers") {
      const { offers } = parse(importSchema, request.payload, rid);
      // All or nothing: one prohibited row refuses the whole import, and each error names its row.
      const errors: Record<string, string> = {};
      offers.forEach((o, i) => Object.assign(errors, fieldErrorsOf(evaluateTerms(o.terms, policy), `offers.${i}.`)));
      if (Object.keys(errors).length) fail("POLICY_VIOLATION", "Commission-only policy: one or more rows have prohibited terms. Nothing was imported.", rid, { fieldErrors: errors });
      return response(request, "draft", []);
    }
    const p = parse(offerSchema, request.payload, rid);
    const key = p.offerId ?? "(unassigned)";
    const current = offerVersions.get(key) ?? FIRST_OFFER_VERSION;
    // The version is checked before the terms, as offer save does.
    if (request.expectedVersion !== current) fail("STALE_VERSION", "This offer changed. Reload it before saving.", rid, { currentVersion: current });
    requireEligible(p.terms, rid);
    if (kind === "editOffer") offerVersions.set(key, `v${Number(current.slice(1)) + 1}`);
    else offerVersions.set(key, current);
    const offerVersion = offerVersions.get(key)!;
    if (kind === "dispatchOffer") {
      stats.dispatches += 1;
      return { ...response(request, "succeeded", [], [`demo-offer-receipt-${request.idempotencyKey}`]), offerVersion, modelVersion: "model@demo-1" };
    }
    return { ...response(request, "draft", []), offerVersion };
  }

  return {
    stats,
    replies,
    get policy() { return policy; },
    handles: (request: ActionRequest<unknown>) => (POLICY_ACTIONS as readonly string[]).includes(request.actionKind),
    /** Same key and payload returns the first result; the same key with a changed payload is refused, as the approval service does. */
    submit(request: ActionRequest<unknown>): ActionResponse {
      const hash = JSON.stringify([request.operation, request.actionKind, request.approvalRef, request.manifestRef, request.expectedVersion, request.payload]);
      return once(request.idempotencyKey, hash, request.requestId, () => apply(request));
    },
    /** Remember the policy an approval was made under, so a later change is measured against it. */
    recordApproval(approvalRef: string) {
      approvedUnder.set(approvalRef, { ...policy });
    },
    /**
     * Called before an approved action first dispatches (never on a replay of a stored result). Throws when the approval
     * no longer fits the policy in force, or when its terms can't be established: it fails closed.
     */
    guardApprovedDispatch(request: ActionRequest<unknown>): void {
      const rid = request.requestId;
      const ref = request.approvalRef;
      const refuse = (reason: string) => fail("POLICY_VIOLATION", `The policy could not be checked for this approval (${reason}). Nothing was sent.`, rid);
      if (!ref) return refuse("no approval named");
      let terms: AcquisitionTerms | null | undefined;
      try {
        terms = opts.termsOf?.(ref);
      } catch (e) {
        if (e instanceof AdapterError) throw e;
        return refuse("its terms could not be read");
      }
      if (terms === undefined) return refuse("its terms are unknown");
      if (terms === null) return; // an accepted historical liability, paid as accepted
      const check = checkApprovedDispatch(approvedUnder.get(ref) ?? BASE_POLICY, policy, terms);
      if (check.ok) return;
      const fieldErrors: Record<string, string> = {};
      check.changes.forEach((c) => (fieldErrors[`policy.${c.field}`] = `${c.from} → ${c.to}`));
      check.blockers.forEach((b) => (fieldErrors[b.field] ??= b.message));
      // Approved under the policy still in force and it fails: the terms were never allowed. Otherwise the policy moved.
      if (check.reasonCodes.includes("POLICY_VIOLATION"))
        fail("POLICY_VIOLATION", `Commission-only policy: ${check.blockers.map((b) => b.message).join(" ")} Nothing was sent.`, rid, { fieldErrors });
      const changed = check.changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join("; ");
      fail("MANIFEST_CHANGED", `The policy changed after this was approved${changed ? ` (${changed})` : ""}. Nothing was sent. It needs a new preview and approval.`, rid, { fieldErrors });
    },
  };
}
