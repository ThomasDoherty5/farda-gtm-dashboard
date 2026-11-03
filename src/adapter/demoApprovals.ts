import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError, type AdapterErrorBody } from "./errors";
import type { ApprovalDetail, ControlPayload, DecidePayload, ReconcilePayload, RunCounts, RunDetail, RunItem } from "@/features/approvals/types";
import { DEMO_ACTOR_ROLE, seedApprovals, seedRuns, sourceLookups } from "@/fixtures/approvals";
import { DEMO_NOW } from "@/fixtures/overview";

type Capability = ReadResponse<unknown>["capabilities"][number];

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

const countItems = (items: RunItem[]): RunCounts => {
  const counts: RunCounts = { confirmed: 0, failed: 0, held: 0, unsent: 0, paused: 0, uncertain: 0 };
  for (const i of items) counts[i.state] += 1;
  return counts;
};

/**
 * In-memory stand-in for the approval service and runner, so the UI can be exercised end to end.
 * It enforces what the real server must (role, version, expiry, policy, idempotency), receives
 * nothing from the client as authority, and contacts no provider. State resets on reload.
 */
export function createDemoApprovals() {
  const approvals = new Map(seedApprovals().map((a) => [a.approvalRef, a]));
  const runs = new Map(seedRuns().map((r) => [r.runRef, r]));
  const results = new Map<string, { hash: string; result: Promise<ActionResponse> }>();
  const stats = { dispatches: 0 };
  let conflictFired = false;

  const respond = <T>(request: ReadRequest<unknown>, data: T, dataVersion: string, capabilities: Capability[]): ReadResponse<T> => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    dataVersion,
    dataState: "ready",
    data,
    sourceFreshness: [],
    coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
    capabilities,
    page: { nextCursor: null, hasMore: false },
    refresh: { nextPollAfterMs: null },
  });

  const approvalCapabilities = (a: ApprovalDetail): Capability[] => {
    if (a.status === "expired") return [{ actionKind: "decideApproval", state: "held", reasonCodes: ["APPROVAL_EXPIRED"] }];
    if (a.status === "pending") {
      if (a.requiredRole !== DEMO_ACTOR_ROLE) return [{ actionKind: "decideApproval", state: "denied", reasonCodes: ["ROLE_REQUIRED"] }];
      return [{ actionKind: "decideApproval", state: "available", reasonCodes: [] }];
    }
    if (a.status === "approved" && !a.execution) return [{ actionKind: "dispatchApprovedAction", state: "available", reasonCodes: [] }];
    return [];
  };

  const runCapabilities = (r: Omit<RunDetail, "counts">): Capability[] => {
    const uncertain = r.state === "outcomeUncertain";
    const pausable = uncertain ? !r.pausedAt : r.items.some((i) => i.state === "unsent");
    const needsEvidence = (found: boolean): Pick<Capability, "state" | "reasonCodes"> => (found ? { state: "available", reasonCodes: [] } : { state: "held", reasonCodes: ["EVIDENCE_REQUIRED"] });
    return [
      { actionKind: "pauseRun", state: pausable ? "available" : "held", reasonCodes: pausable ? [] : ["NOTHING_TO_PAUSE"] },
      ...(uncertain
        ? [
            { actionKind: "lookupSource", state: "available" as const, reasonCodes: [] },
            { actionKind: "recordConfirmedSent", ...needsEvidence(r.reconciliation.result === "sourceReceiptFound") },
            { actionKind: "requestFreshAttempt", ...needsEvidence(r.reconciliation.result === "confirmedNotExecuted") },
          ]
        : []),
    ];
  };

  const actionResponse = (request: ActionRequest<unknown>, state: ActionResponse["state"], over: Partial<ActionResponse> = {}): ActionResponse => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    actionRef: `demo-action-${request.idempotencyKey}`,
    state,
    runRef: null,
    approvalRef: request.approvalRef,
    manifestRef: request.manifestRef,
    payloadVersion: request.expectedVersion,
    policyVersion: "commission-only@demo",
    modelVersion: null,
    offerVersion: null,
    reasonCodes: [],
    receiptRefs: [],
    nextAction: null,
    nextPollAfterMs: null,
    ...over,
  });

  const findApproval = (request: ActionRequest<unknown>) =>
    approvals.get(request.approvalRef ?? "") ?? fail("RECORD_NOT_FOUND", "This approval does not exist.", request.requestId);
  const findRun = (request: ActionRequest<unknown>, runRef: string) =>
    runs.get(runRef) ?? fail("RECORD_NOT_FOUND", "This run does not exist.", request.requestId);

  const expectVersion = (request: ActionRequest<unknown>, current: string) => {
    if (request.expectedVersion !== current)
      fail("STALE_VERSION", "This record changed. Review the current version before deciding.", request.requestId, { currentVersion: current });
  };

  function decide(request: ActionRequest<DecidePayload>): ActionResponse {
    const a = findApproval(request);
    if (a.requiredRole !== DEMO_ACTOR_ROLE) fail("SOURCE_AUTHORITY_DENIED", `Only a ${a.requiredRole} can decide this approval.`, request.requestId);
    if (a.status === "expired") fail("APPROVAL_EXPIRED", "This approval expired. It needs a fresh preview.", request.requestId);
    if (a.approvalRef === "demo-approval-conflict" && !conflictFired) {
      conflictFired = true;
      const prior = a.versions[a.versions.length - 1]!;
      const next = { ...prior, version: "v2", payloadHash: "demo-hash-conflict", payload: { ...prior.payload, terms: { ...prior.payload.terms, commissionRatePct: 20 } } };
      a.versions = [...a.versions, next];
      a.currentVersion = next.version;
    }
    expectVersion(request, a.currentVersion);
    if (a.status !== "pending") fail("APPROVAL_INVALID", "This approval was already decided.", request.requestId);

    const current = a.versions[a.versions.length - 1]!;
    const { decision, reason, editedMessage } = request.payload;
    const reasonText = reason?.trim() ?? "";
    if (decision === "approved" && current.payload.terms.upfrontFee.minorUnits > 0 && a.requiredRole !== "founder")
      fail("POLICY_VIOLATION", "New acquisition is commission-only, so an upfront fee can't be approved.", request.requestId, { fieldErrors: { upfrontFee: "Upfront fee must be zero for new acquisition." } });
    if (decision === "rejected" && !reasonText) fail("VALIDATION_FAILED", "A reason is required to reject.", request.requestId, { fieldErrors: { reason: "Enter a reason for rejecting." } });
    if (decision === "editRequired") {
      const text = editedMessage?.trim() ?? "";
      if (!text) fail("VALIDATION_FAILED", "The edited message can't be empty.", request.requestId, { fieldErrors: { editedMessage: "Enter the message to send." } });
      if (text === current.payload.message) fail("VALIDATION_FAILED", "The message has not changed.", request.requestId, { fieldErrors: { editedMessage: "Change the message, or approve it as written." } });
      const n = a.versions.length;
      current.decision = "editRequired";
      current.decidedByRole = DEMO_ACTOR_ROLE;
      current.decidedAt = DEMO_NOW;
      current.reason = reasonText || null;
      current.decisionReceiptRef = `demo-decision-receipt-${a.approvalRef}-${current.version}`;
      const next = { ...current, version: `v${n + 1}`, payloadHash: `demo-hash-${n + 1}`, payload: { ...current.payload, message: text }, decision: null, decidedByRole: null, decidedAt: null, reason: null, decisionReceiptRef: null };
      a.versions = [...a.versions, next];
      a.currentVersion = next.version;
      return actionResponse(request, "approvalPending", { payloadVersion: next.version, reasonCodes: ["EDIT_NEEDS_FRESH_APPROVAL"] });
    }

    current.decision = decision;
    current.decidedByRole = DEMO_ACTOR_ROLE;
    current.decidedAt = DEMO_NOW;
    current.reason = reasonText || null;
    current.decisionReceiptRef = `demo-decision-receipt-${a.approvalRef}-${current.version}`;
    a.status = decision;
    if (decision === "rejected") return actionResponse(request, "canceled", { receiptRefs: [current.decisionReceiptRef] });
    // The contract has no "approved" state. Blocked-awaiting-dispatch is the closest truthful one; raised for the THO-283 freeze.
    return actionResponse(request, "blocked", {
      reasonCodes: ["AWAITING_DISPATCH"],
      nextAction: { kind: "dispatchApprovedAction", ownerRef: null, dueAt: a.expiresAt, available: true },
    });
  }

  function dispatch(request: ActionRequest<unknown>): ActionResponse {
    const a = findApproval(request);
    if (a.status !== "approved") fail("APPROVAL_REQUIRED", "This action has no valid approval.", request.requestId);
    expectVersion(request, a.currentVersion);
    if (a.execution) return actionResponse(request, a.execution.state, { runRef: a.execution.runRef, receiptRefs: a.execution.receiptRefs });

    stats.dispatches += 1;
    const recipient = a.versions[a.versions.length - 1]!.payload.recipients[0]!;
    if (a.approvalRef === "demo-approval-uncertain") {
      a.execution = { runRef: "demo-run-uncertain", state: "outcomeUncertain", receiptRefs: [] };
      return actionResponse(request, "outcomeUncertain", { runRef: "demo-run-uncertain", reasonCodes: ["TIMEOUT_AFTER_SUBMIT"], nextAction: { kind: "reconcileRun", ownerRef: null, dueAt: null, available: true } });
    }
    const runRef = `demo-run-${a.approvalRef.replace("demo-approval-", "")}`;
    const receiptRef = `demo-source-receipt-${a.approvalRef}`;
    runs.set(runRef, { ...seedRuns()[0]!, runRef, approvalRef: a.approvalRef, mode: "executeApproved", trigger: "Approved action", correlationId: `corr-${runRef}`, state: "succeeded", items: [{ itemId: "item-1", recipient, state: "confirmed", receiptRef, reasonCode: null }] });
    a.execution = { runRef, state: "succeeded", receiptRefs: [receiptRef] };
    return actionResponse(request, "succeeded", { runRef, receiptRefs: [receiptRef] });
  }

  function control(request: ActionRequest<ControlPayload>): ActionResponse {
    const r = findRun(request, request.payload.runRef);
    expectVersion(request, r.version);
    if (r.state === "outcomeUncertain") {
      r.pausedAt ??= DEMO_NOW;
    } else {
      r.items = r.items.map((i) => (i.state === "unsent" ? { ...i, state: "paused" } : i));
      r.state = "paused";
      r.pausedAt = DEMO_NOW;
    }
    r.version = `r${Number(r.version.slice(1)) + 1}`;
    return actionResponse(request, r.state, { runRef: r.runRef, payloadVersion: r.version });
  }

  function reconcile(request: ActionRequest<ReconcilePayload>): ActionResponse {
    const r = findRun(request, request.payload.runRef);
    const a = approvals.get(r.approvalRef);
    const receipts = () => r.items.flatMap((i) => (i.receiptRef ? [i.receiptRef] : []));
    if (r.state === "succeeded") return actionResponse(request, "succeeded", { runRef: r.runRef, receiptRefs: receipts(), reasonCodes: ["ALREADY_RECONCILED"] });
    expectVersion(request, r.version);
    const bump = () => { r.version = `r${Number(r.version.slice(1)) + 1}`; };

    if (request.payload.request === "lookup") {
      r.reconciliation = sourceLookups[r.runRef] ?? { result: "stillUnknown", evidence: null };
      bump();
      return actionResponse(request, r.state, { runRef: r.runRef, payloadVersion: r.version, reasonCodes: [r.reconciliation.result] });
    }
    if (request.payload.request === "recordConfirmedSent") {
      const evidence = r.reconciliation.evidence;
      if (r.reconciliation.result !== "sourceReceiptFound" || !evidence) return fail("OUTCOME_UNCERTAIN", "No verified source receipt, so this can't be recorded as sent.", request.requestId, { executionCertainty: "uncertain" });
      r.items = r.items.map((i) => (i.state === "uncertain" ? { ...i, state: "confirmed", receiptRef: evidence.receiptRef, reasonCode: null } : i));
      r.state = "succeeded";
      bump();
      if (a?.execution?.runRef === r.runRef) a.execution = { runRef: r.runRef, state: "succeeded", receiptRefs: [evidence.receiptRef] };
      return actionResponse(request, "succeeded", { runRef: r.runRef, payloadVersion: r.version, receiptRefs: [evidence.receiptRef] });
    }
    if (r.reconciliation.result !== "confirmedNotExecuted") return fail("OUTCOME_UNCERTAIN", "The earlier attempt isn't proven to have failed, so it can't be retried.", request.requestId, { executionCertainty: "uncertain" });
    r.items = r.items.map((i) => (i.state === "uncertain" ? { ...i, state: "unsent", reasonCode: null } : i));
    r.state = "queued";
    r.attempt += 1;
    r.reconciliation = { result: "notChecked", evidence: null };
    bump();
    return actionResponse(request, "queued", { runRef: r.runRef, payloadVersion: r.version });
  }

  const apply = (request: ActionRequest<unknown>): ActionResponse => {
    switch (request.operation) {
      case "decideApproval":
        return decide(request as ActionRequest<DecidePayload>);
      case "dispatchApprovedAction":
        return dispatch(request);
      case "controlRun":
        return control(request as ActionRequest<ControlPayload>);
      case "reconcileRun":
        return reconcile(request as ActionRequest<ReconcilePayload>);
      default:
        return fail("INTEGRATION_PENDING", `No demo behavior for ${request.operation}.`, request.requestId);
    }
  };

  return {
    stats,
    readApproval(request: ReadRequest<{ approvalId: string }>) {
      const { approvalId } = request.filters;
      if (approvalId === "demo-approval-forbidden") fail("FORBIDDEN", "You do not have access to this approval.", request.requestId);
      const a = approvals.get(approvalId) ?? fail("RECORD_NOT_FOUND", "This approval does not exist or was removed.", request.requestId);
      return respond(request, structuredClone(a), a.currentVersion, approvalCapabilities(a));
    },
    readRun(request: ReadRequest<{ runId: string }>) {
      const r = runs.get(request.filters.runId) ?? fail("RECORD_NOT_FOUND", "This run does not exist or was removed.", request.requestId);
      const detail: RunDetail = { ...structuredClone(r), counts: countItems(r.items) };
      return respond(request, detail, r.version, runCapabilities(r));
    },
    /** Same key and payload returns the original result; same key with a changed payload is refused. */
    submit<P>(request: ActionRequest<P>): Promise<ActionResponse> {
      const hash = JSON.stringify([request.operation, request.actionKind, request.approvalRef, request.manifestRef, request.expectedVersion, request.payload]);
      const prior = results.get(request.idempotencyKey);
      if (prior && prior.hash !== hash)
        return Promise.reject(new AdapterError({ code: "MANIFEST_CHANGED", message: "This action changed, so it needs a fresh preview.", requestId: request.requestId, correlationId: `demo-${request.requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" }));
      if (prior) return prior.result;
      const result = Promise.resolve().then(() => apply(request));
      results.set(request.idempotencyKey, { hash, result });
      result.catch(() => results.delete(request.idempotencyKey));
      return result;
    },
  };
}
