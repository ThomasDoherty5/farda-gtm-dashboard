// @vitest-environment node
import { describe, expect, it } from "vitest";
import { actionResponseSchema, SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { foundationActionSchema } from "../actions/service.ts";
import { workflowIntentSchema } from "../collaborationWorkflowSchema.ts";
import { approvalReconciliationFor, collaborationProposalFor, FOLLOW_UP_ACTION_KIND, outcomeFromActionResponse, previewActionFor, reconciliationFor } from "./actionAdapter.ts";
import { FollowUpRepository } from "./repository.ts";
import { clockEvent, collaborationId, followUpConfig, followUpDatabase, followUpScope, laNoon } from "./fixtures.testkit.ts";

function proposed(day = "2026-11-10") {
  const db = followUpDatabase(), clock = { at: laNoon(day) };
  const repo = new FollowUpRepository(db, followUpScope, followUpConfig, () => clock.at);
  const receipt = repo.planReminder({ event: clockEvent(), collaborationId, outreach: "clear", postedVerified: false }, "plan-1");
  return { repo, intent: receipt.intent! };
}
const context = { scope: followUpScope, requestId: "synthetic-request-1" };
function response(over: Partial<ActionResponse>): ActionResponse {
  return actionResponseSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-request-1",
    scope: { workspaceId: followUpScope.workspaceId, accountIds: [followUpScope.accountId], environment: "sandbox", authorizationScopeVersion: "actions.scope.v1" },
    actionRef: "synthetic-approval", state: "approvalPending", runRef: null, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", payloadVersion: "av1-1.1-" + "a".repeat(64),
    policyVersion: "synthetic-policy", modelVersion: null, offerVersion: null, reasonCodes: [], receiptRefs: [], nextAction: null, nextPollAfterMs: null, executionCertainty: "applied", ...over });
}

describe("follow-up action intents", () => {
  it("emits a J04 preview that the actions service schema accepts, bound to the exact intent version", () => {
    const { intent } = proposed();
    const action = previewActionFor(intent, context);
    expect(foundationActionSchema.parse(action)).toEqual(action);
    expect(action).toMatchObject({ operation: "previewAction", actionKind: FOLLOW_UP_ACTION_KIND, approvalRef: null, manifestRef: null,
      expectedVersion: intent.intentVersion, payload: { entityRef: collaborationId, entityVersion: intent.intentVersion, selectionRefs: [intent.intentRef] } });
  });
  it("emits nothing to send for human review items or anything already handed off", () => {
    const { repo, intent } = proposed();
    repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" }, "outcome-1");
    expect(() => previewActionFor(repo.intent(intent.intentRef)!, context)).toThrow("INTENT_NOT_PROPOSED");
    const late = proposed("2026-11-15").intent;
    expect(late.channel).toBe("human-review");
    expect(() => previewActionFor(late, context)).toThrow("INTENT_NOT_SENDABLE");
  });
  it("reconciles an uncertain dispatch with a run lookup, never a fresh attempt", () => {
    const { repo, intent } = proposed();
    const uncertain = repo.recordSendOutcome(outcomeFromActionResponse(intent.intentRef, response({ state: "outcomeUncertain", runRef: "synthetic-run", executionCertainty: "uncertain" })), "outcome-1");
    const result = reconciliationFor(uncertain, { ...context, idempotencyKey: "reconcile-1" });
    expect(result.kind).toBe("action");
    const action = result.kind === "action" ? result.action : null;
    expect(foundationActionSchema.parse(action)).toEqual(action);
    expect(action).toMatchObject({ operation: "reconcileRun", actionKind: "lookup", runRef: "synthetic-run", payload: { request: "lookup" } });
  });
  it("reconciles an uncertain approval request through the service and holds when nothing identifies it", () => {
    const { repo, intent } = proposed();
    const uncertain = repo.recordSendOutcome({ kind: "uncertain", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", runRef: null, runVersion: null }, "outcome-1");
    expect(reconciliationFor(uncertain, { ...context, idempotencyKey: "reconcile-1" })).toEqual({ kind: "hold", reasonCode: "APPROVAL_RECONCILIATION_REQUIRED" });
    const action = approvalReconciliationFor(uncertain, { ...context, idempotencyKey: "reconcile-2", approvalVersion: "av1-1.1-" + "b".repeat(64) });
    expect(foundationActionSchema.parse(action)).toMatchObject({ operation: "requestApproval", actionKind: "reconcileApproval", approvalRef: "synthetic-approval" });
    const bare = proposed(), bareIntent = bare.repo.recordSendOutcome({ kind: "uncertain", intentRef: bare.intent.intentRef, approvalRef: null, manifestRef: null, runRef: null, runVersion: null }, "outcome-1");
    expect(reconciliationFor(bareIntent, { ...context, idempotencyKey: "reconcile-3" })).toEqual({ kind: "hold", reasonCode: "UNCERTAIN_OUTCOME_NEEDS_OPERATOR" });
  });
  it("never reads approved, queued or running as sent", () => {
    expect(outcomeFromActionResponse("follow-up-x", response({ state: "approved" })).kind).toBe("approvalRecorded");
    expect(outcomeFromActionResponse("follow-up-x", response({ state: "queued", runRef: "synthetic-run" })).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse("follow-up-x", response({ state: "succeeded", runRef: "synthetic-run", receiptRefs: [] })).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse("follow-up-x", response({ state: "succeeded", runRef: "synthetic-run", receiptRefs: ["effect-1"] }))).toMatchObject({ kind: "sent", receiptRefs: ["effect-1"] });
    expect(outcomeFromActionResponse("follow-up-x", response({ state: "partiallySucceeded", runRef: "synthetic-run" })).kind).toBe("uncertain");
  });
  it("emits collaboration proposals in the existing workflow intent shape", () => {
    const late = proposed("2026-11-15").intent;
    const handoff = collaborationProposalFor({ kind: "handoff", intent: late }, collaborationId);
    const close = collaborationProposalFor({ kind: "closure", closure: { collaborationId, reason: "terms-mismatch", evidenceRef: "synthetic-reply", reasonCodes: ["CREATOR_FEE_REQUEST"], closedAt: "2026-11-15T20:00:00.000Z" } }, collaborationId);
    expect(workflowIntentSchema.parse(handoff)).toMatchObject({ kind: "human-handoff" });
    expect(workflowIntentSchema.parse(close)).toMatchObject({ kind: "close", outcome: "canceled" });
    expect(close.reason).toContain("terms-mismatch");
  });
});
