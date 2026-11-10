import { SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { foundationActionSchema, type FoundationAction } from "../actions/wire.ts";
import { workflowIntentSchema, type WorkflowIntent } from "../collaborationWorkflowSchema.ts";
import type { OperationsScope } from "../operations.ts";
import type { ClosureRecord } from "./repository.ts";
import type { SendOutcome, StoredIntent } from "./contract.ts";

/**
 * Translates follow-up intents into envelopes the existing actions service accepts. It produces requests only:
 * nothing here calls the service, registers a handler or sends a message. Each intent has one send path: a `preDue`
 * creator reminder goes to J04 exact-action approval via `previewAction`; a `postGraceOnly` reminder and human-review
 * items go to the collaboration workflow's own approval proposal.
 */
export const FOLLOW_UP_ACTION_KIND = "creatorFollowUpReminder";
type Context = { scope: OperationsScope; requestId: string };
const requestedScope = (scope: OperationsScope) => ({ workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment });

export class FollowUpAdapterError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** A J04 preview for one proposed creator reminder. The approval binds to the exact intent version. */
export function previewActionFor(intent: StoredIntent, context: Context): FoundationAction {
  if (intent.sendPath !== "j04Preview") throw new FollowUpAdapterError("INTENT_NOT_ON_J04_PATH");
  if (intent.state !== "proposed") throw new FollowUpAdapterError("INTENT_NOT_PROPOSED");
  return foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: context.requestId, requestedScope: requestedScope(context.scope),
    operation: "previewAction", actionKind: FOLLOW_UP_ACTION_KIND, expectedVersion: intent.intentVersion, idempotencyKey: "follow-up-preview:" + intent.intentRef,
    entityRefs: [], approvalRef: null, manifestRef: null,
    payload: { entityRef: intent.collaborationId, entityVersion: intent.intentVersion, selectionRefs: [intent.intentRef] } });
}

export type Reconciliation = { kind: "action"; action: FoundationAction } | { kind: "hold"; reasonCode: string };
/**
 * The only follow-up for an uncertain send: the actions service's own reconciliation. A dispatched run is looked
 * up, never re-attempted; an uncertain approval request is reconciled; anything else waits for a person.
 */
export function reconciliationFor(intent: StoredIntent, context: Context & { idempotencyKey: string }): Reconciliation {
  if (intent.state !== "uncertain") throw new FollowUpAdapterError("INTENT_NOT_UNCERTAIN");
  // A workflow handoff reconciles through the workflow's own detail read with `proposalRequestKey`.
  if (intent.sendPath !== "j04Preview") return { kind: "hold", reasonCode: "WORKFLOW_PROPOSAL_LOOKUP_REQUIRED" };
  const base = { schemaVersion: SCHEMA_VERSION, requestId: context.requestId, requestedScope: requestedScope(context.scope), idempotencyKey: context.idempotencyKey, entityRefs: [] };
  if (intent.runRef && intent.runVersion && intent.approvalRef && intent.manifestRef)
    return { kind: "action", action: foundationActionSchema.parse({ ...base, operation: "reconcileRun", actionKind: "lookup", runRef: intent.runRef,
      expectedVersion: intent.runVersion, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, payload: { request: "lookup" } }) };
  // An uncertain approval request reconciles through `approvalReconciliationFor` with the signed approval version.
  if (!intent.runRef && intent.approvalRef && intent.manifestRef) return { kind: "hold", reasonCode: "APPROVAL_RECONCILIATION_REQUIRED" };
  return { kind: "hold", reasonCode: "UNCERTAIN_OUTCOME_NEEDS_OPERATOR" };
}

/** Same as above for an uncertain approval request, when the caller holds the signed approval version. */
export function approvalReconciliationFor(intent: StoredIntent, context: Context & { idempotencyKey: string; approvalVersion: string }): FoundationAction {
  if (intent.sendPath !== "j04Preview" || intent.state !== "uncertain" || intent.runRef || !intent.approvalRef || !intent.manifestRef)
    throw new FollowUpAdapterError("INTENT_NOT_APPROVAL_UNCERTAIN");
  return foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: context.requestId, requestedScope: requestedScope(context.scope),
    idempotencyKey: context.idempotencyKey, entityRefs: [], operation: "requestApproval", actionKind: "reconcileApproval",
    approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, expectedVersion: context.approvalVersion, payload: {} });
}

const APPROVAL_PENDING_STATES = ["draft", "approvalPending", "approved"];
/**
 * Maps an actions-service answer for one intent to a follow-up outcome. Approved, queued or running is never sent.
 * A blocked answer without a run is a held approval, not a recorded one. The intent's first signed run version
 * stays the binding: the service accepts any of its signed run versions for a lookup.
 */
export function outcomeFromActionResponse(intent: StoredIntent, response: ActionResponse): SendOutcome {
  const intentRef = intent.intentRef, { approvalRef, manifestRef, runRef } = response;
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
export function outcomeFromActionError(intent: StoredIntent, error: { code: string; executionCertainty: "notApplied" | "applied" | "uncertain" }): SendOutcome {
  if (error.executionCertainty === "notApplied" && !intent.runRef)
    return { kind: "approvalHeld", intentRef: intent.intentRef, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, reasonCodes: heldReasons([error.code], "ACTION_DENIED") };
  return { kind: "uncertain", intentRef: intent.intentRef, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, runRef: intent.runRef, runVersion: intent.runVersion };
}

/**
 * Collaboration review proposal payloads for human-review items and closures, in the existing workflow intent shape.
 * Its closure outcomes are coarser than ours, so the exact closure reason code is kept in the reason text.
 */
const OUTCOME: Record<ClosureRecord["reason"], WorkflowIntent["outcome"]> = {
  "posted-verified": "completed", declined: "declined", expired: "no-response", "terms-mismatch": "canceled",
  "rights-unavailable": "canceled", cancelled: "canceled",
};
/** The stable request key for an intent's workflow proposal, also used for its `proposalRequestKey` lookup. */
export const workflowRequestKeyFor = (intent: StoredIntent) => "follow-up-workflow:" + intent.intentRef;

/**
 * Workflow proposal payloads. An intent qualifies only on its own workflow send path and only while `proposed`;
 * once handed off, `recordWorkflowHandoff` moves it on so it cannot be proposed twice.
 */
export function collaborationProposalFor(item: { kind: "handoff"; intent: StoredIntent } | { kind: "closure"; closure: ClosureRecord }, collaborationRef: string): WorkflowIntent {
  if (item.kind === "closure") {
    const c = item.closure;
    return workflowIntentSchema.parse({ collaborationRef, kind: "close", outcome: OUTCOME[c.reason], reason: `Follow-up closed: ${c.reason} (${c.reasonCodes.join(", ")})` });
  }
  const intent = item.intent;
  if (intent.sendPath === "j04Preview") throw new FollowUpAdapterError("INTENT_NOT_ON_WORKFLOW_PATH");
  if (intent.state !== "proposed") throw new FollowUpAdapterError("INTENT_NOT_PROPOSED");
  return intent.sendPath === "workflowReminder"
    ? workflowIntentSchema.parse({ collaborationRef, kind: "reminder", reason: `Follow-up post-grace reminder: ${intent.reasonCodes.join(", ")}` })
    : workflowIntentSchema.parse({ collaborationRef, kind: "human-handoff", reason: `Follow-up ${intent.step}: ${intent.reasonCodes.join(", ")}` });
}
