import { SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { foundationActionSchema, type FoundationAction } from "../actions/wire.ts";
import { workflowIntentSchema, type WorkflowIntent } from "../collaborationWorkflowSchema.ts";
import type { OperationsScope } from "../operations.ts";
import type { ClosureRecord } from "./repository.ts";
import type { SendOutcome, StoredIntent } from "./contract.ts";

/**
 * Translates follow-up intents into envelopes the existing actions service accepts. It produces requests only:
 * nothing here calls the service, registers a handler or sends a message. Every creator message goes through
 * J04 exact-action approval via `previewAction`.
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
  if (intent.channel !== "creator-message") throw new FollowUpAdapterError("INTENT_NOT_SENDABLE");
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
  if (intent.state !== "uncertain" || intent.runRef || !intent.approvalRef || !intent.manifestRef) throw new FollowUpAdapterError("INTENT_NOT_APPROVAL_UNCERTAIN");
  return foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: context.requestId, requestedScope: requestedScope(context.scope),
    idempotencyKey: context.idempotencyKey, entityRefs: [], operation: "requestApproval", actionKind: "reconcileApproval",
    approvalRef: intent.approvalRef, manifestRef: intent.manifestRef, expectedVersion: context.approvalVersion, payload: {} });
}

/** Maps an actions-service answer to a follow-up outcome. Approved, queued or running is never treated as sent. */
export function outcomeFromActionResponse(intentRef: string, response: ActionResponse): SendOutcome {
  const { approvalRef, manifestRef, runRef } = response;
  if (response.executionCertainty === "uncertain" || ["outcomeUncertain", "reconciling", "partiallySucceeded"].includes(response.state))
    return { kind: "uncertain", intentRef, approvalRef, manifestRef, runRef, runVersion: runRef ? response.payloadVersion : null };
  if (!approvalRef || !manifestRef) throw new FollowUpAdapterError("APPROVAL_REFERENCE_MISSING");
  if (!runRef) {
    if (["failed", "canceled"].includes(response.state)) return { kind: "notSent", intentRef, approvalRef, manifestRef, runRef: null, runVersion: null, receiptRefs: response.receiptRefs };
    return { kind: "approvalRecorded", intentRef, approvalRef, manifestRef };
  }
  const runVersion = response.payloadVersion;
  if (response.state === "succeeded" && response.executionCertainty === "applied" && response.receiptRefs.length)
    return { kind: "sent", intentRef, approvalRef, manifestRef, runRef, runVersion, receiptRefs: response.receiptRefs };
  if (["failed", "canceled"].includes(response.state)) return { kind: "notSent", intentRef, approvalRef, manifestRef, runRef, runVersion, receiptRefs: response.receiptRefs };
  return { kind: "dispatchPending", intentRef, approvalRef, manifestRef, runRef, runVersion };
}

/**
 * Collaboration review proposal payloads for human-review items and closures, in the existing workflow intent shape.
 * Its closure outcomes are coarser than ours, so the exact closure reason code is kept in the reason text.
 */
const OUTCOME: Record<ClosureRecord["reason"], WorkflowIntent["outcome"]> = {
  "posted-verified": "completed", declined: "declined", expired: "no-response", "terms-mismatch": "canceled",
  "rights-unavailable": "canceled", cancelled: "canceled",
};
export function collaborationProposalFor(item: { kind: "handoff"; intent: StoredIntent } | { kind: "closure"; closure: ClosureRecord }, collaborationRef: string): WorkflowIntent {
  if (item.kind === "handoff") {
    if (item.intent.channel !== "human-review") throw new FollowUpAdapterError("INTENT_NOT_HUMAN_REVIEW");
    return workflowIntentSchema.parse({ collaborationRef, kind: "human-handoff", reason: `Follow-up ${item.intent.step}: ${item.intent.reasonCodes.join(", ")}` });
  }
  const c = item.closure;
  return workflowIntentSchema.parse({ collaborationRef, kind: "close", outcome: OUTCOME[c.reason], reason: `Follow-up closed: ${c.reason} (${c.reasonCodes.join(", ")})` });
}
