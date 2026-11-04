import { SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "./contract";
import { AdapterError } from "./errors";
import { BASE_POLICY, checkApprovedDispatch, evaluateTerms, fieldErrorsOf, routeCreatorReply, type AcquisitionTerms, type PolicyConfig } from "./commissionPolicy";

const fail = (code: string, message: string, requestId: string, extra: { fieldErrors?: Record<string, string> } = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

export const POLICY_ACTIONS = ["createOffer", "editOffer", "importOffers", "dispatchOffer", "recordCreatorReply", "changeAcquisitionPolicy"] as const;
type PolicyAction = (typeof POLICY_ACTIONS)[number];

export type OfferPayload = { offerId?: string; terms: AcquisitionTerms };
export type ImportPayload = { offers: OfferPayload[] };
export type ReplyPayload = { creatorRef: string; sourceRef: string; text: string };
export type PolicyChangePayload = Partial<Omit<PolicyConfig, "version">> & { version: string };

/**
 * In-memory stand-in for server-side acquisition-policy enforcement. It re-evaluates the submitted terms
 * itself and trusts no client flag, so a manipulated payload is refused. Fixture evidence only: the
 * authenticated adapter (THO-283) must enforce the same rule. Nothing is sent, funded or reserved here.
 */
export function createDemoPolicy(opts: { termsOf?: (approvalRef: string) => AcquisitionTerms | null } = {}) {
  let policy: PolicyConfig = { ...BASE_POLICY };
  /** The policy an approval was made under. Anything unlisted was approved under the starting policy. */
  const approvedUnder = new Map<string, PolicyConfig>();
  const stats = { dispatches: 0, counterOffers: 0 };
  const replies: { creatorRef: string; state: string; reasonCodes: string[] }[] = [];
  const results = new Map<string, ActionResponse>();

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

  function requireEligible(terms: AcquisitionTerms, rid: string, prefix = "") {
    const e = evaluateTerms(terms, policy);
    if (!e.eligible) fail("POLICY_VIOLATION", `Commission-only policy: ${e.blockers.map((b) => b.message).join(" ")}`, rid, { fieldErrors: fieldErrorsOf(e, prefix) });
  }

  function apply(request: ActionRequest<unknown>): ActionResponse {
    const kind = request.actionKind as PolicyAction;
    const rid = request.requestId;
    if (kind === "changeAcquisitionPolicy") {
      const p = request.payload as PolicyChangePayload;
      policy = { ...policy, ...p };
      return response(request, "succeeded", ["POLICY_VERSION_CHANGED"]);
    }
    if (kind === "recordCreatorReply") {
      const p = request.payload as ReplyPayload;
      const route = routeCreatorReply(p.text, p.sourceRef);
      replies.push({ creatorRef: p.creatorRef, state: route.state, reasonCodes: route.reasonCodes });
      // A fee request holds the item for review. It never dispatches and never produces a counter-offer.
      return response(request, route.kind === "feeRequest" ? "blocked" : "succeeded", route.reasonCodes, [route.evidence.sourceRef]);
    }
    if (kind === "importOffers") {
      const { offers } = request.payload as ImportPayload;
      // All or nothing: one prohibited row refuses the whole import, and each error names its row.
      const errors: Record<string, string> = {};
      offers.forEach((o, i) => Object.assign(errors, fieldErrorsOf(evaluateTerms(o.terms, policy), `offers.${i}.`)));
      if (Object.keys(errors).length) fail("POLICY_VIOLATION", "Commission-only policy: one or more rows have prohibited terms. Nothing was imported.", rid, { fieldErrors: errors });
      return response(request, "draft", []);
    }
    const p = request.payload as OfferPayload;
    requireEligible(p.terms, rid);
    if (kind === "dispatchOffer") {
      stats.dispatches += 1;
      return { ...response(request, "succeeded", [], [`demo-offer-receipt-${request.idempotencyKey}`]), offerVersion: p.offerId ?? null, modelVersion: "model@demo-1" };
    }
    return response(request, "draft", []);
  }

  return {
    stats,
    replies,
    get policy() { return policy; },
    handles: (request: ActionRequest<unknown>) => (POLICY_ACTIONS as readonly string[]).includes(request.actionKind),
    submit(request: ActionRequest<unknown>): ActionResponse {
      const prior = results.get(request.idempotencyKey);
      if (prior) return prior;
      const result = apply(request);
      results.set(request.idempotencyKey, result);
      return result;
    },
    /** Called before an approved action dispatches. Throws when the approval no longer fits the policy in force. */
    guardApprovedDispatch(request: ActionRequest<unknown>): void {
      const ref = request.approvalRef;
      const terms = ref ? opts.termsOf?.(ref) : null;
      if (!ref || !terms) return;
      const check = checkApprovedDispatch(approvedUnder.get(ref) ?? BASE_POLICY, policy, terms);
      if (check.ok) return;
      const changed = check.changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join("; ");
      const fieldErrors: Record<string, string> = {};
      check.changes.forEach((c) => (fieldErrors[`policy.${c.field}`] = `${c.from} → ${c.to}`));
      check.blockers.forEach((b) => (fieldErrors[b.field] ??= b.message));
      fail("MANIFEST_CHANGED", `The policy changed after this was approved${changed ? ` (${changed})` : ""}. Nothing was sent. It needs a new preview and approval.`, request.requestId, { fieldErrors });
    },
  };
}
