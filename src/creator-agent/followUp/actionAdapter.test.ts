// @vitest-environment node
import { describe, expect, it } from "vitest";
import { actionResponseSchema, SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { foundationActionSchema } from "../actions/service.ts";
import { workflowIntentSchema } from "../collaborationWorkflowSchema.ts";
import type { FollowUpConfig } from "./contract.ts";
import { approvalReconciliationFor, collaborationProposalFor, FOLLOW_UP_ACTION_KIND, outcomeFromActionError, outcomeFromActionResponse,
  previewActionFor, reconciliationFor, workflowRequestKeyFor } from "./actionAdapter.ts";
import { FollowUpRepository } from "./repository.ts";
import { clockEvent, collaborationId, followUpConfig, followUpDatabase, followUpScope, laNoon, postGraceConfig } from "./fixtures.testkit.ts";

function proposed(day = "2026-11-10", config: FollowUpConfig = followUpConfig) {
  const db = followUpDatabase(), clock = { at: laNoon(day) };
  const repo = new FollowUpRepository(db, followUpScope, config, () => clock.at);
  const receipt = repo.planReminder({ event: clockEvent(), collaborationId, outreach: "clear", postedVerified: false }, "plan-1");
  return { repo, intent: receipt.proposals[0]!.intent, proposals: receipt.proposals.map(p => p.intent) };
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
    expect(() => previewActionFor(late, context)).toThrow("INTENT_NOT_ON_J04_PATH");
  });
  it("reconciles an uncertain dispatch with a run lookup, never a fresh attempt", () => {
    const { repo, intent } = proposed();
    const outcome = outcomeFromActionResponse(intent, response({ state: "outcomeUncertain", runRef: "synthetic-run", executionCertainty: "uncertain" }));
    const receipt = repo.recordSendOutcome(outcome, "outcome-1");
    const result = reconciliationFor(receipt.intent, { ...context, idempotencyKey: "reconcile-1" });
    expect(result.kind).toBe("action");
    const action = result.kind === "action" ? result.action : null;
    expect(foundationActionSchema.parse(action)).toEqual(action);
    expect(action).toMatchObject({ operation: "reconcileRun", actionKind: "lookup", runRef: "synthetic-run", payload: { request: "lookup" } });
  });
  it("keeps the first signed run version as the binding across later responses", () => {
    const { repo, intent } = proposed();
    const first = repo.recordSendOutcome(outcomeFromActionResponse(intent, response({ state: "queued", runRef: "synthetic-run", payloadVersion: "av1-1.1-" + "c".repeat(64) })), "outcome-1").intent;
    const later = outcomeFromActionResponse(first, response({ state: "succeeded", runRef: "synthetic-run", payloadVersion: "av1-1.2-" + "d".repeat(64), receiptRefs: ["effect-1"] }));
    expect(later).toMatchObject({ kind: "sent", runVersion: "av1-1.1-" + "c".repeat(64) });
    expect(repo.recordSendOutcome(later, "outcome-2").intent.state).toBe("sent");
  });
  it("reconciles an uncertain approval request through the service and holds when nothing identifies it", () => {
    const { repo, intent } = proposed();
    const uncertain = repo.recordSendOutcome({ kind: "uncertain", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", runRef: null, runVersion: null }, "outcome-1").intent;
    expect(reconciliationFor(uncertain, { ...context, idempotencyKey: "reconcile-1" })).toEqual({ kind: "hold", reasonCode: "APPROVAL_RECONCILIATION_REQUIRED" });
    const action = approvalReconciliationFor(uncertain, { ...context, idempotencyKey: "reconcile-2", approvalVersion: "av1-1.1-" + "b".repeat(64) });
    expect(foundationActionSchema.parse(action)).toMatchObject({ operation: "requestApproval", actionKind: "reconcileApproval", approvalRef: "synthetic-approval" });
    const bare = proposed(), bareIntent = bare.repo.recordSendOutcome({ kind: "uncertain", intentRef: bare.intent.intentRef, approvalRef: null, manifestRef: null, runRef: null, runVersion: null }, "outcome-1").intent;
    expect(reconciliationFor(bareIntent, { ...context, idempotencyKey: "reconcile-3" })).toEqual({ kind: "hold", reasonCode: "UNCERTAIN_OUTCOME_NEEDS_OPERATOR" });
  });
  it("never reads approved, queued or running as sent", () => {
    const { intent } = proposed();
    expect(outcomeFromActionResponse(intent, response({ state: "approved" })).kind).toBe("approvalRecorded");
    expect(outcomeFromActionResponse(intent, response({ state: "queued", runRef: "synthetic-run" })).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse(intent, response({ state: "succeeded", runRef: "synthetic-run", receiptRefs: [] })).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse(intent, response({ state: "succeeded", runRef: "synthetic-run", receiptRefs: ["effect-1"] }))).toMatchObject({ kind: "sent", receiptRefs: ["effect-1"] });
    expect(outcomeFromActionResponse(intent, response({ state: "partiallySucceeded", runRef: "synthetic-run" })).kind).toBe("uncertain");
  });
  it("maps a blocked approval or a denial to a held state, not a recorded approval", () => {
    const { intent } = proposed();
    expect(outcomeFromActionResponse(intent, response({ state: "blocked", reasonCodes: ["SOURCE_ACTION_UNSUPPORTED"] })))
      .toEqual({ kind: "approvalHeld", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", reasonCodes: ["SOURCE_ACTION_UNSUPPORTED"] });
    expect(outcomeFromActionResponse(intent, response({ state: "blocked", reasonCodes: ["not a code"] }))).toMatchObject({ kind: "approvalHeld", reasonCodes: ["APPROVAL_BLOCKED"] });
    expect(outcomeFromActionError(intent, { code: "AUTHORITY_REQUIRED", executionCertainty: "notApplied" })).toMatchObject({ kind: "approvalHeld", reasonCodes: ["AUTHORITY_REQUIRED"] });
    expect(outcomeFromActionError(intent, { code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" }).kind).toBe("uncertain");
  });
  it("emits collaboration proposals in the existing workflow intent shape", () => {
    const late = proposed("2026-11-15").intent;
    const handoff = collaborationProposalFor({ kind: "handoff", intent: late }, collaborationId);
    const close = collaborationProposalFor({ kind: "closure", closure: { collaborationId, reason: "terms-mismatch", evidenceRef: "synthetic-reply", reasonCodes: ["CREATOR_FEE_REQUEST"], closedAt: "2026-11-15T20:00:00.000Z" } }, collaborationId);
    expect(workflowIntentSchema.parse(handoff)).toMatchObject({ kind: "human-handoff" });
    expect(workflowIntentSchema.parse(close)).toMatchObject({ kind: "close", outcome: "canceled" });
    expect(close.reason).toContain("terms-mismatch");
  });
  it("gives a postGraceOnly reminder only the workflow path, and a preDue reminder only the J04 path", () => {
    const { proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    expect(reminder).toMatchObject({ channel: "creator-message", sendPath: "workflowReminder" });
    expect(workflowIntentSchema.parse(collaborationProposalFor({ kind: "handoff", intent: reminder }, collaborationId))).toMatchObject({ kind: "reminder" });
    expect(() => previewActionFor(reminder, context)).toThrow("INTENT_NOT_ON_J04_PATH");
    const preDue = proposed().intent;
    expect(preDue.sendPath).toBe("j04Preview");
    expect(() => collaborationProposalFor({ kind: "handoff", intent: preDue }, collaborationId)).toThrow("INTENT_NOT_ON_WORKFLOW_PATH");
  });
  it("yields no reminder from a withdrawn post-grace intent on either path", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    repo.close(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, "close-1");
    const withdrawn = repo.intent(reminder.intentRef)!;
    expect(withdrawn.state).toBe("superseded");
    expect(() => collaborationProposalFor({ kind: "handoff", intent: withdrawn }, collaborationId)).toThrow("INTENT_NOT_PROPOSED");
    expect(() => previewActionFor(withdrawn, context)).toThrow("INTENT_NOT_ON_J04_PATH");
  });
  it("hands a workflow reminder off once, then refuses to propose it again", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    expect(workflowRequestKeyFor(reminder)).toBe("follow-up-workflow:" + reminder.intentRef);
    const handed = repo.recordWorkflowHandoff({ intentRef: reminder.intentRef, result: "recorded", proposalRef: "proposal-synthetic" }, "handoff-1").intent;
    expect(handed).toMatchObject({ state: "handedOff", workflowProposalRef: "proposal-synthetic" });
    expect(() => collaborationProposalFor({ kind: "handoff", intent: handed }, collaborationId)).toThrow("INTENT_NOT_PROPOSED");
    expect(() => repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: reminder.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" }, "outcome-1"))
      .toThrow("INTENT_NOT_ON_J04_PATH");
  });
  it("leaves an uncertain workflow handoff to the workflow's own key lookup", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    const uncertain = repo.recordWorkflowHandoff({ intentRef: reminder.intentRef, result: "uncertain" }, "handoff-1").intent;
    expect(reconciliationFor(uncertain, { ...context, idempotencyKey: "reconcile-1" })).toEqual({ kind: "hold", reasonCode: "WORKFLOW_PROPOSAL_LOOKUP_REQUIRED" });
    expect(() => collaborationProposalFor({ kind: "handoff", intent: uncertain }, collaborationId)).toThrow("INTENT_NOT_PROPOSED");
  });
});
