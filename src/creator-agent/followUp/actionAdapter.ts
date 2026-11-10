import { SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { foundationActionSchema, type FoundationAction } from "../actions/wire.ts";
import { workflowIntentSchema, type WorkflowIntent } from "../collaborationWorkflowSchema.ts";
import type { FollowUpRepository } from "./repository.ts";
import { workflowRequestKeyOf, type ClosureReason, type SendOutcome, type StoredIntent } from "./contract.ts";
import { FOLLOW_UP_ACTION_KIND, previewEnvelope, previewKeyOf, requestedScopeOf } from "./envelopes.ts";

/**
 * Translates follow-up intents into envelopes the existing actions service accepts. It produces requests only:
 * nothing here calls the service, registers a handler or sends a message. Each intent has one send path: a `preDue`
 * creator reminder goes to J04 exact-action approval via `previewAction`; a `postGraceOnly` reminder and human-review
 * items go to the collaboration workflow's own approval proposal.
 *
 * Every builder takes an intent reference and re-reads it from the repository. A caller's copy of an intent, such
 * as one returned by an earlier `planReminder` replay, is never trusted.
 */
export { FOLLOW_UP_ACTION_KIND };
type Reader = Pick<FollowUpRepository, "intent" | "closure" | "boundScope">;
type Context = { requestId: string };

export class FollowUpAdapterError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function current(repo: Reader, intentRef: string): StoredIntent {
  const intent = repo.intent(intentRef);
  if (!intent) throw new FollowUpAdapterError("RECORD_NOT_FOUND");
  return intent;
}

/**
 * Rebuilds the J04 preview for an intent that `reservePreview` has already reserved, for example to retry a
 * submission. It never reserves: a `proposed`, withdrawn or settled intent is refused.
 */
export function previewActionFor(repo: Reader, intentRef: string, context: Context): FoundationAction {
  const intent = current(repo, intentRef);
  if (intent.sendPath !== "j04Preview") throw new FollowUpAdapterError("INTENT_NOT_ON_J04_PATH");
  if (intent.state !== "previewing") throw new FollowUpAdapterError("INTENT_NOT_RESERVED");
  return previewEnvelope(intent, repo.boundScope(), context.requestId);
}

export type Reconciliation = { kind: "action"; action: FoundationAction } | { kind: "hold"; reasonCode: string; requestKey?: string };
const unknownOutcome = (intent: StoredIntent, from: StoredIntent["state"][]) =>
  from.includes(intent.state) || intent.state === "superseded" && intent.supersededFrom !== null && from.includes(intent.supersededFrom);
/**
 * The only follow-up for an unknown outcome: the owner's own reconciliation. A dispatched run is looked up, never
 * re-attempted; an uncertain approval request is reconciled; anything else waits for a person.
 */
export function reconciliationFor(repo: Reader, intentRef: string, context: Context & { idempotencyKey: string }): Reconciliation {
  const intent = current(repo, intentRef);
  // A workflow handoff, uncertain or reserved but unanswered, reconciles through the workflow's own detail read
  // with `proposalRequestKey`, and holds for an operator until then. Withdrawn ones still need the lookup.
  if (intent.sendPath !== "j04Preview") {
    if (!unknownOutcome(intent, ["uncertain", "handingOff"])) throw new FollowUpAdapterError("INTENT_NOT_UNCERTAIN");
    return { kind: "hold", reasonCode: "WORKFLOW_PROPOSAL_LOOKUP_REQUIRED", requestKey: workflowRequestKeyOf(intent.intentRef) };
  }
  // A reserved preview with no recorded answer: look it up in J04 under its exact preview key before anything else.
  if (unknownOutcome(intent, ["previewing"])) return { kind: "hold", reasonCode: "J04_PREVIEW_LOOKUP_REQUIRED", requestKey: previewKeyOf(intent.intentRef) };
  if (!unknownOutcome(intent, ["uncertain"])) throw new FollowUpAdapterError("INTENT_NOT_UNCERTAIN");
  const base = { schemaVersion: SCHEMA_VERSION, requestId: context.requestId, requestedScope: requestedScopeOf(repo.boundScope()), idempotencyKey: context.idempotencyKey, entityRefs: [] };
  if (intent.runRef && intent.runVersion && intent.approvalRef && intent.manifestRef)
    return { kind: "action", action: foundationActionSchema.parse({ ...base, operation: "reconcileRun", actionKind: "lookup", runRef: intent.runRef,
      expectedVersion: intent.runVersion, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, payload: { request: "lookup" } }) };
  // An uncertain approval request reconciles through `approvalReconciliationFor` with the signed approval version.
  if (!intent.runRef && intent.approvalRef && intent.manifestRef) return { kind: "hold", reasonCode: "APPROVAL_RECONCILIATION_REQUIRED" };
  return { kind: "hold", reasonCode: "UNCERTAIN_OUTCOME_NEEDS_OPERATOR" };
}

/** Same as above for an uncertain approval request, when the caller holds the signed approval version. */
export function approvalReconciliationFor(repo: Reader, intentRef: string, context: Context & { idempotencyKey: string; approvalVersion: string }): FoundationAction {
  const intent = current(repo, intentRef);
  if (intent.sendPath !== "j04Preview" || !unknownOutcome(intent, ["uncertain"]) || intent.runRef || !intent.approvalRef || !intent.manifestRef)
    throw new FollowUpAdapterError("INTENT_NOT_APPROVAL_UNCERTAIN");
  return foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: context.requestId, requestedScope: requestedScopeOf(repo.boundScope()),
    idempotencyKey: context.idempotencyKey, entityRefs: [], operation: "requestApproval", actionKind: "reconcileApproval",
    approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, expectedVersion: context.approvalVersion, payload: {} });
}

const APPROVAL_PENDING_STATES = ["draft", "approvalPending", "approved"];
/**
 * Maps an actions-service answer for one intent to a follow-up outcome. Approved, queued or running is never sent.
 * A blocked answer without a run is a held approval, not a recorded one. The intent's first signed run version
 * stays the binding: the service accepts any of its signed run versions for a lookup.
 */
export function outcomeFromActionResponse(repo: Reader, intentRef: string, response: ActionResponse): SendOutcome {
  const intent = current(repo, intentRef), { approvalRef, manifestRef, runRef } = response;
  const runVersion = runRef && runRef === intent.runRef && intent.runVersion ? intent.runVersion : runRef ? response.payloadVersion : null;
  if (response.executionCertainty === "uncertain" || ["outcomeUncertain", "reconciling", "partiallySucceeded"].includes(response.state))
    return { kind: "uncertain", intentRef, approvalRef, manifestRef, runRef, runVersion };
  if (!runRef) {
    if (["failed", "canceled"].includes(response.state)) return { kind: "notSent", intentRef, approvalRef, manifestRef, runRef: null, runVersion: null, receiptRefs: response.receiptRefs };
    if (approvalRef && manifestRef && APPROVAL_PENDING_STATES.includes(response.state)) return { kind: "approvalRecorded", intentRef, approvalRef, manifestRef };
    return { kind: "approvalHeld", intentRef, approvalRef, manifestRef, reasonCodes: heldReasons(response.reasonCodes, "APPROVAL_" + response.state.toUpperCase()) };
  }
  if (!approvalRef || !manifestRef || !runVersion) throw new FollowUpAdapterError("APPROVAL_REFERENCE_MISSING");
  if (response.state === "succeeded" && response.executionCertainty === "applied" && response.receiptRefs.length)
    return { kind: "sent", intentRef, approvalRef, manifestRef, runRef, runVersion, receiptRefs: response.receiptRefs };
  if (["failed", "canceled"].includes(response.state)) return { kind: "notSent", intentRef, approvalRef, manifestRef, runRef, runVersion, receiptRefs: response.receiptRefs };
  return { kind: "dispatchPending", intentRef, approvalRef, manifestRef, runRef, runVersion };
}
const heldReasons = (codes: string[], fallback: string) => {
  const valid = codes.filter(code => /^[A-Z][A-Z0-9_]{0,99}$/.test(code)).slice(0, 20);
  return valid.length ? valid : [fallback];
};
/**
 * Maps a thrown actions-service error for one intent. A denial that applied nothing is a held approval; an
 * uncertain or ambiguous error is uncertain and goes to reconciliation, never a retry.
 */
export function outcomeFromActionError(repo: Reader, intentRef: string, error: { code: string; executionCertainty: "notApplied" | "applied" | "uncertain" }): SendOutcome {
  const intent = current(repo, intentRef);
  if (error.executionCertainty === "notApplied" && !intent.runRef)
    return { kind: "approvalHeld", intentRef, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, reasonCodes: heldReasons([error.code], "ACTION_DENIED") };
  return { kind: "uncertain", intentRef, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, runRef: intent.runRef, runVersion: intent.runVersion };
}

/**
 * The workflow's closure outcomes are coarser than ours, so the exact closure reason code is kept in the reason text.
 */
const OUTCOME: Record<ClosureReason, WorkflowIntent["outcome"]> = {
  "posted-verified": "completed", declined: "declined", expired: "no-response", "terms-mismatch": "canceled",
  "rights-unavailable": "canceled", cancelled: "canceled",
};
/** The stable request key for an intent's workflow proposal, also used for its `proposalRequestKey` lookup. */
export const workflowRequestKeyFor = (intentRef: string) => workflowRequestKeyOf(intentRef);

/**
 * Workflow proposal payloads, re-read from the repository. An intent qualifies only on its own workflow send path and
 * only after `reserveWorkflowHandoff` has moved it to `handingOff`. A closure needs a recorded closure.
 */
export function collaborationProposalFor(repo: Reader, item: { kind: "handoff"; intentRef: string } | { kind: "closure"; collaborationId: string }, collaborationRef: string): WorkflowIntent {
  if (item.kind === "closure") {
    const c = repo.closure(item.collaborationId);
    if (!c) throw new FollowUpAdapterError("CLOSURE_NOT_RECORDED");
    return workflowIntentSchema.parse({ collaborationRef, kind: "close", outcome: OUTCOME[c.reason], reason: `Follow-up closed: ${c.reason} (${c.reasonCodes.join(", ")})` });
  }
  const intent = current(repo, item.intentRef);
  if (intent.sendPath === "j04Preview") throw new FollowUpAdapterError("INTENT_NOT_ON_WORKFLOW_PATH");
  if (intent.state !== "handingOff") throw new FollowUpAdapterError("INTENT_NOT_RESERVED");
  return intent.sendPath === "workflowReminder"
    ? workflowIntentSchema.parse({ collaborationRef, kind: "reminder", reason: `Follow-up post-grace reminder: ${intent.reasonCodes.join(", ")}` })
    : workflowIntentSchema.parse({ collaborationRef, kind: "human-handoff", reason: `Follow-up ${intent.step}: ${intent.reasonCodes.join(", ")}` });
}
