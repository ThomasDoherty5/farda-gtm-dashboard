import { SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { foundationActionSchema, type FoundationAction } from "../actions/wire.ts";
import type { OperationsScope } from "../operations.ts";
import type { Ref, SendOutcome, StoredIntent } from "./contract.ts";

/**
 * Translates onboarding intents into envelopes the existing actions service accepts. It builds requests only: nothing
 * here calls the service, registers a handler or sends. Every builder takes an intent reference and re-reads the intent
 * from the repository; a caller's copy of an intent is never trusted.
 */
type Reader = { intent(intentRef: string): StoredIntent | null; boundScope(): OperationsScope };
type Context = { requestId: string };

export class OnboardingAdapterError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const requestedScopeOf = (scope: OperationsScope) => ({ workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment });
export const previewKeyOf = (intentRef: string) => "affiliate-onboarding-preview:" + intentRef;

/** @internal The J04 preview for one reserved intent. Callers pass an intent they have just re-read. */
export function previewEnvelope(intent: StoredIntent, scope: OperationsScope, requestId: string): FoundationAction {
  return foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId, requestedScope: requestedScopeOf(scope),
    operation: "previewAction", actionKind: intent.actionKind, expectedVersion: intent.intentVersion, idempotencyKey: previewKeyOf(intent.intentRef),
    entityRefs: [], approvalRef: null, manifestRef: null,
    payload: { entityRef: intent.onboardingId, entityVersion: intent.intentVersion, selectionRefs: [intent.intentRef] } });
}

function current(repo: Reader, intentRef: string): StoredIntent {
  const intent = repo.intent(intentRef);
  if (!intent) throw new OnboardingAdapterError("RECORD_NOT_FOUND");
  return intent;
}

/** Rebuilds the preview for an intent already reserved, for a retry. It never reserves. */
export function previewActionFor(repo: Reader, intentRef: string, context: Context): FoundationAction {
  const intent = current(repo, intentRef);
  if (intent.state !== "previewing") throw new OnboardingAdapterError("INTENT_NOT_RESERVED");
  return previewEnvelope(intent, repo.boundScope(), context.requestId);
}

export type ReconciliationStep = { kind: "action"; action: FoundationAction } | { kind: "hold"; reasonCode: string; requestKey?: string };
/**
 * The only next step for an unknown outcome: the owner's own lookup, never a fresh attempt. A reserved preview is
 * looked up by its exact key; a dispatched run is looked up through J04; anything else waits for source reconciliation.
 */
export function reconciliationFor(repo: Reader, intentRef: string, context: Context & { idempotencyKey: string }): ReconciliationStep {
  const intent = current(repo, intentRef);
  const from = intent.state === "superseded" ? intent.supersededFrom : intent.state;
  if (from === "previewing") return { kind: "hold", reasonCode: "J04_PREVIEW_LOOKUP_REQUIRED", requestKey: previewKeyOf(intent.intentRef) };
  if (from !== "reconciliationRequired") throw new OnboardingAdapterError("INTENT_NOT_UNCERTAIN");
  if (intent.runRef && intent.runVersion && intent.approvalRef && intent.manifestRef)
    return { kind: "action", action: foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: context.requestId,
      requestedScope: requestedScopeOf(repo.boundScope()), idempotencyKey: context.idempotencyKey, entityRefs: [], operation: "reconcileRun",
      actionKind: "lookup", runRef: intent.runRef, expectedVersion: intent.runVersion, approvalRef: intent.approvalRef, manifestRef: intent.manifestRef,
      payload: { request: "lookup" } }) };
  return { kind: "hold", reasonCode: "SOURCE_RECONCILIATION_REQUIRED" };
}

const PENDING = ["draft", "approvalPending", "approved"];
const codes = (values: string[], fallback: string) => {
  const valid = values.filter(code => /^[A-Z][A-Z0-9_]{0,99}$/.test(code)).slice(0, 20);
  return valid.length ? valid : [fallback];
};
/**
 * Maps an actions-service answer for one intent. Approved, queued or running is never sent. A succeeded run counts as
 * sent only with the provider's own native receipt; without one the outcome is uncertain and goes to reconciliation.
 */
export function outcomeFromActionResponse(repo: Reader, intentRef: string, response: ActionResponse, providerReceipt: Ref | null,
  options: { expiresAt?: string | null; runDeadline?: string | null } = {}): SendOutcome {
  const intent = current(repo, intentRef), { approvalRef, manifestRef, runRef } = response;
  const expiresAt = options.expiresAt ?? null, runDeadline = options.runDeadline ?? null;
  const runVersion = runRef && runRef === intent.runRef && intent.runVersion ? intent.runVersion : runRef ? response.payloadVersion : null;
  const uncertain = { kind: "uncertain" as const, intentRef, approvalRef, manifestRef, runRef, runVersion, runDeadline };
  if (response.executionCertainty === "uncertain" || ["outcomeUncertain", "reconciling", "partiallySucceeded"].includes(response.state)) return uncertain;
  if (!runRef) {
    if (["failed", "canceled"].includes(response.state)) return { kind: "notSent", intentRef, approvalRef, manifestRef, runRef: null, receiptRefs: response.receiptRefs };
    if (approvalRef && manifestRef && PENDING.includes(response.state)) return { kind: "approvalRecorded", intentRef, approvalRef, manifestRef };
    return { kind: "approvalHeld", intentRef, approvalRef, manifestRef, reasonCodes: codes(response.reasonCodes, "APPROVAL_" + response.state.toUpperCase()) };
  }
  if (!approvalRef || !manifestRef || !runVersion) throw new OnboardingAdapterError("APPROVAL_REFERENCE_MISSING");
  if (response.state === "succeeded" && response.executionCertainty === "applied" && response.receiptRefs.length)
    return providerReceipt ? { kind: "sent", intentRef, approvalRef, manifestRef, runRef, runVersion, receiptRefs: response.receiptRefs, providerReceipt, expiresAt } : uncertain;
  if (["failed", "canceled"].includes(response.state)) return { kind: "notSent", intentRef, approvalRef, manifestRef, runRef, receiptRefs: response.receiptRefs };
  return { kind: "dispatchPending", intentRef, approvalRef, manifestRef, runRef, runVersion, runDeadline };
}
