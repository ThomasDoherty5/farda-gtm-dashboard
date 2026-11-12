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
/** A preDue reminder reserved for J04. */
function previewing() {
  const { repo, intent } = proposed();
  const reservation = repo.reservePreview(intent.intentRef, "preview-1", { requestId: "synthetic-request-1" });
  return { repo, intent: reservation.intent, action: reservation.action };
}
const context = { requestId: "synthetic-request-1" };
function response(over: Partial<ActionResponse>): ActionResponse {
  return actionResponseSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-request-1",
    scope: { workspaceId: followUpScope.workspaceId, accountIds: [followUpScope.accountId], environment: "sandbox", authorizationScopeVersion: "actions.scope.v1" },
    actionRef: "synthetic-approval", state: "approvalPending", runRef: null, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", payloadVersion: "av1-1.1-" + "a".repeat(64),
    policyVersion: "synthetic-policy", modelVersion: null, offerVersion: null, reasonCodes: [], receiptRefs: [], nextAction: null, nextPollAfterMs: null, executionCertainty: "applied", ...over });
}

describe("follow-up action intents", () => {
  it("reserves a J04 preview that the actions service schema accepts, bound to the exact intent version", () => {
    const { repo, intent, action } = previewing();
    expect(foundationActionSchema.parse(action)).toEqual(action);
    expect(action).toMatchObject({ operation: "previewAction", actionKind: FOLLOW_UP_ACTION_KIND, approvalRef: null, manifestRef: null,
      expectedVersion: intent.intentVersion, payload: { entityRef: collaborationId, entityVersion: intent.intentVersion, selectionRefs: [intent.intentRef] } });
    expect(previewActionFor(repo, intent.intentRef, context)).toEqual(action);
  });
  it("refuses to build a preview from a stale proposed copy after closure (planReminder replay)", () => {
    const { repo, intent } = proposed();
    repo.close(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, "close-1");
    const copy = repo.planReminder({ event: clockEvent(), collaborationId, outreach: "clear", postedVerified: false }, "plan-1").proposals[0]!.intent;
    expect(copy).toMatchObject({ intentRef: intent.intentRef, state: "proposed" });
    expect(repo.intent(copy.intentRef)?.state).toBe("superseded");
    expect(() => previewActionFor(repo, copy.intentRef, context)).toThrow("INTENT_NOT_RESERVED");
    expect(() => repo.reservePreview(copy.intentRef, "preview-1", context)).toThrow("INTENT_NOT_PROPOSED");
    expect(repo.conflicts(collaborationId)).toEqual([]);
  });
  it("builds no preview for an unreserved, human-review or already handed-off intent", () => {
    const { repo, intent } = proposed();
    expect(() => previewActionFor(repo, intent.intentRef, context)).toThrow("INTENT_NOT_RESERVED");
    repo.reservePreview(intent.intentRef, "preview-1", context);
    repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" }, "outcome-1");
    expect(() => previewActionFor(repo, intent.intentRef, context)).toThrow("INTENT_NOT_RESERVED");
    const late = proposed("2026-11-15");
    expect(late.intent.channel).toBe("human-review");
    expect(() => previewActionFor(late.repo, late.intent.intentRef, context)).toThrow("INTENT_NOT_ON_J04_PATH");
    expect(() => late.repo.reservePreview(late.intent.intentRef, "preview-1", context)).toThrow("INTENT_NOT_ON_J04_PATH");
  });
  it("holds a reserved but unanswered preview for a lookup under its exact preview key", () => {
    const { repo, intent } = previewing();
    expect(reconciliationFor(repo, intent.intentRef, { ...context, idempotencyKey: "reconcile-1" }))
      .toEqual({ kind: "hold", reasonCode: "J04_PREVIEW_LOOKUP_REQUIRED", requestKey: "follow-up-preview:" + intent.intentRef });
  });
  it("reconciles an uncertain dispatch with a run lookup, never a fresh attempt", () => {
    const { repo, intent } = previewing();
    repo.recordSendOutcome(outcomeFromActionResponse(repo, intent.intentRef, response({ state: "outcomeUncertain", runRef: "synthetic-run", executionCertainty: "uncertain" })), "outcome-1");
    const result = reconciliationFor(repo, intent.intentRef, { ...context, idempotencyKey: "reconcile-1" });
    expect(result.kind).toBe("action");
    const action = result.kind === "action" ? result.action : null;
    expect(foundationActionSchema.parse(action)).toEqual(action);
    expect(action).toMatchObject({ operation: "reconcileRun", actionKind: "lookup", runRef: "synthetic-run", payload: { request: "lookup" } });
  });
  it("keeps the first signed run version as the binding across later responses", () => {
    const { repo, intent } = previewing();
    repo.recordSendOutcome(outcomeFromActionResponse(repo, intent.intentRef, response({ state: "queued", runRef: "synthetic-run", payloadVersion: "av1-1.1-" + "c".repeat(64) })), "outcome-1");
    const later = outcomeFromActionResponse(repo, intent.intentRef, response({ state: "succeeded", runRef: "synthetic-run", payloadVersion: "av1-1.2-" + "d".repeat(64), receiptRefs: ["effect-1"] }));
    expect(later).toMatchObject({ kind: "sent", runVersion: "av1-1.1-" + "c".repeat(64) });
    expect(repo.recordSendOutcome(later, "outcome-2").intent.state).toBe("sent");
  });
  it("reconciles an uncertain approval request through the service and holds when nothing identifies it", () => {
    const { repo, intent } = previewing();
    repo.recordSendOutcome({ kind: "uncertain", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", runRef: null, runVersion: null }, "outcome-1");
    expect(reconciliationFor(repo, intent.intentRef, { ...context, idempotencyKey: "reconcile-1" })).toEqual({ kind: "hold", reasonCode: "APPROVAL_RECONCILIATION_REQUIRED" });
    const action = approvalReconciliationFor(repo, intent.intentRef, { ...context, idempotencyKey: "reconcile-2", approvalVersion: "av1-1.1-" + "b".repeat(64) });
    expect(foundationActionSchema.parse(action)).toMatchObject({ operation: "requestApproval", actionKind: "reconcileApproval", approvalRef: "synthetic-approval" });
    const bare = previewing();
    bare.repo.recordSendOutcome({ kind: "uncertain", intentRef: bare.intent.intentRef, approvalRef: null, manifestRef: null, runRef: null, runVersion: null }, "outcome-1");
    expect(reconciliationFor(bare.repo, bare.intent.intentRef, { ...context, idempotencyKey: "reconcile-3" })).toEqual({ kind: "hold", reasonCode: "UNCERTAIN_OUTCOME_NEEDS_OPERATOR" });
  });
  it("never reads approved, queued or running as sent", () => {
    const { repo, intent } = previewing(), ref = intent.intentRef;
    expect(outcomeFromActionResponse(repo, ref, response({ state: "approved" })).kind).toBe("approvalRecorded");
    expect(outcomeFromActionResponse(repo, ref, response({ state: "queued", runRef: "synthetic-run" })).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse(repo, ref, response({ state: "succeeded", runRef: "synthetic-run", receiptRefs: [] })).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse(repo, ref, response({ state: "succeeded", runRef: "synthetic-run", receiptRefs: ["effect-1"] }))).toMatchObject({ kind: "sent", receiptRefs: ["effect-1"] });
    expect(outcomeFromActionResponse(repo, ref, response({ state: "partiallySucceeded", runRef: "synthetic-run" })).kind).toBe("uncertain");
  });
  it("maps a blocked approval or a denial to a held state, not a recorded approval", () => {
    const { repo, intent } = previewing(), ref = intent.intentRef;
    expect(outcomeFromActionResponse(repo, ref, response({ state: "blocked", reasonCodes: ["SOURCE_ACTION_UNSUPPORTED"] })))
      .toEqual({ kind: "approvalHeld", intentRef: ref, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", reasonCodes: ["SOURCE_ACTION_UNSUPPORTED"] });
    expect(outcomeFromActionResponse(repo, ref, response({ state: "blocked", reasonCodes: ["not a code"] }))).toMatchObject({ kind: "approvalHeld", reasonCodes: ["APPROVAL_BLOCKED"] });
    expect(outcomeFromActionError(repo, ref, { code: "AUTHORITY_REQUIRED", executionCertainty: "notApplied" })).toMatchObject({ kind: "approvalHeld", reasonCodes: ["AUTHORITY_REQUIRED"] });
    expect(outcomeFromActionError(repo, ref, { code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" }).kind).toBe("uncertain");
  });
  it("emits collaboration proposals in the existing workflow intent shape, read from the repository", () => {
    const { repo, intent: late } = proposed("2026-11-15");
    repo.reserveWorkflowHandoff(late.intentRef, "reserve-1");
    expect(workflowIntentSchema.parse(collaborationProposalFor(repo, { kind: "handoff", intentRef: late.intentRef }, collaborationId))).toMatchObject({ kind: "human-handoff" });
    expect(() => collaborationProposalFor(repo, { kind: "closure", collaborationId }, collaborationId)).toThrow("CLOSURE_NOT_RECORDED");
    repo.close(collaborationId, { reason: "terms-mismatch", terms: { kind: "reply", text: "I charge a flat fee per post", sourceRef: "synthetic-reply" } }, "close-1");
    const close = collaborationProposalFor(repo, { kind: "closure", collaborationId }, collaborationId);
    expect(workflowIntentSchema.parse(close)).toMatchObject({ kind: "close", outcome: "canceled" });
    expect(close.reason).toContain("terms-mismatch");
  });
  it("gives a postGraceOnly reminder only the workflow path, and a preDue reminder only the J04 path", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    expect(reminder).toMatchObject({ channel: "creator-message", sendPath: "workflowReminder" });
    expect(() => collaborationProposalFor(repo, { kind: "handoff", intentRef: reminder.intentRef }, collaborationId)).toThrow("INTENT_NOT_RESERVED");
    const reserved = repo.reserveWorkflowHandoff(reminder.intentRef, "reserve-1");
    expect(reserved.requestKey).toBe(workflowRequestKeyFor(reminder.intentRef));
    expect(workflowIntentSchema.parse(collaborationProposalFor(repo, { kind: "handoff", intentRef: reminder.intentRef }, collaborationId))).toMatchObject({ kind: "reminder" });
    expect(() => previewActionFor(repo, reminder.intentRef, context)).toThrow("INTENT_NOT_ON_J04_PATH");
    expect(() => repo.reservePreview(reminder.intentRef, "preview-1", context)).toThrow("INTENT_NOT_ON_J04_PATH");
    const preDue = proposed();
    expect(preDue.intent.sendPath).toBe("j04Preview");
    expect(() => collaborationProposalFor(preDue.repo, { kind: "handoff", intentRef: preDue.intent.intentRef }, collaborationId)).toThrow("INTENT_NOT_ON_WORKFLOW_PATH");
  });
  it("yields no reminder from a withdrawn post-grace intent on either path", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    repo.close(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, "close-1");
    expect(repo.intent(reminder.intentRef)?.state).toBe("superseded");
    expect(() => collaborationProposalFor(repo, { kind: "handoff", intentRef: reminder.intentRef }, collaborationId)).toThrow("INTENT_NOT_RESERVED");
    expect(() => previewActionFor(repo, reminder.intentRef, context)).toThrow("INTENT_NOT_ON_J04_PATH");
  });
  it("hands a workflow reminder off once, then refuses to propose it again", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    expect(workflowRequestKeyFor(reminder.intentRef)).toBe("follow-up-workflow:" + reminder.intentRef);
    repo.reserveWorkflowHandoff(reminder.intentRef, "reserve-1");
    const handed = repo.recordWorkflowHandoff({ intentRef: reminder.intentRef, result: "recorded", proposalRef: "proposal-synthetic" }, "handoff-1").intent;
    expect(handed).toMatchObject({ state: "handedOff", workflowProposalRef: "proposal-synthetic" });
    expect(() => collaborationProposalFor(repo, { kind: "handoff", intentRef: reminder.intentRef }, collaborationId)).toThrow("INTENT_NOT_RESERVED");
    expect(() => repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: reminder.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" }, "outcome-1"))
      .toThrow("INTENT_NOT_ON_J04_PATH");
  });
  it("leaves an uncertain or unanswered workflow handoff to the workflow's own key lookup", () => {
    const { repo, proposals } = proposed("2026-11-15", postGraceConfig);
    const reminder = proposals.find(i => i.step === "post-grace")!;
    repo.reserveWorkflowHandoff(reminder.intentRef, "reserve-1");
    const hold = { kind: "hold", reasonCode: "WORKFLOW_PROPOSAL_LOOKUP_REQUIRED", requestKey: workflowRequestKeyFor(reminder.intentRef) };
    // A reservation that is never answered is reconcilable by its key and held for an operator.
    expect(reconciliationFor(repo, reminder.intentRef, { ...context, idempotencyKey: "reconcile-0" })).toEqual(hold);
    expect(repo.pendingReconciliation().map(i => i.intentRef)).toEqual([reminder.intentRef]);
    repo.recordWorkflowHandoff({ intentRef: reminder.intentRef, result: "uncertain" }, "handoff-1");
    expect(reconciliationFor(repo, reminder.intentRef, { ...context, idempotencyKey: "reconcile-1" })).toEqual(hold);
    expect(() => collaborationProposalFor(repo, { kind: "handoff", intentRef: reminder.intentRef }, collaborationId)).toThrow("INTENT_NOT_RESERVED");
  });
});
