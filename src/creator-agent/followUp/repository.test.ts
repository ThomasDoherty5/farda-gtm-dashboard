// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import type { StoredAsset } from "../assets.ts";
import { assetTestNow, assetTestScope, syntheticAsset, syntheticChecksum, syntheticRights, syntheticUse } from "../assetTestFixtures.ts";
import type { FollowUpConfig } from "./contract.ts";
import { FollowUpRepository } from "./repository.ts";
import { clockEvent, collaborationId, deliveryEvidence, followUpConfig, followUpDatabase, followUpScope, laNoon, postGraceConfig, unsetConfig } from "./fixtures.testkit.ts";

function setup(start = laNoon("2026-11-10"), config: FollowUpConfig = followUpConfig) {
  const db = followUpDatabase(), clock = { at: start, readsInsideLock: [] as boolean[] };
  const repo = new FollowUpRepository(db, followUpScope, config, () => { clock.readsInsideLock.push(db.isTransaction); return clock.at; });
  return { db, repo, clock };
}
const plan = (event = clockEvent(), outreach: "clear" | "suppressed" | "unknown" = "clear") => ({ event, collaborationId, outreach, postedVerified: false });
const approval = { approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" };
const run = { ...approval, runRef: "synthetic-run", runVersion: "synthetic-run-v1" };
function storedAsset(): StoredAsset {
  return { submission: syntheticAsset(), version: 1, recordedAt: assetTestNow, submissionHash: digest(syntheticAsset()), storageIdentity: "synthetic-storage",
    sourceEvidence: { scope: assetTestScope, submissionHash: digest(syntheticAsset()), observedAt: assetTestNow, authorizationRef: "synthetic-source", availability: "available", checksum: syntheticChecksum } };
}

describe("follow-up repository", () => {
  it("binds to the shared agent database scope", () => {
    const db = followUpDatabase({ ...followUpScope, accountId: "other-account" });
    expect(() => new FollowUpRepository(db, followUpScope, followUpConfig)).toThrow("DATABASE_SCOPE_MISMATCH");
  });
  it("refuses to plan creator reminders until a reminder policy is set", () => {
    const { db, repo } = setup(laNoon("2026-11-10"), unsetConfig);
    expect(() => repo.planReminder(plan(), "plan-1")).toThrow("REMINDER_POLICY_UNSET");
    expect(db.prepare("SELECT COUNT(*) AS n FROM creator_follow_up_intents").get()?.n).toBe(0);
  });
  it("under postGraceOnly proposes nothing before grace, then one reminder plus the human-review escalation", () => {
    const { repo, clock } = setup(laNoon("2026-11-10"), postGraceConfig);
    expect(repo.planReminder(plan(), "plan-1")).toMatchObject({ decision: { kind: "wait", opensOn: "2026-11-15" }, proposals: [] });
    clock.at = laNoon("2026-11-14");
    expect(repo.planReminder(plan(), "plan-2").proposals).toEqual([]);
    clock.at = laNoon("2026-11-15");
    const late = repo.planReminder(plan(), "plan-3");
    expect(late.proposals.map(p => [p.intent.step, p.intent.channel, p.created])).toEqual([["past-grace", "human-review", true], ["post-grace", "creator-message", true]]);
    clock.at = laNoon("2026-11-16");
    expect(repo.planReminder(plan(), "plan-4").proposals.map(p => p.created)).toEqual([false, false]);
  });
  it("reads the injected clock only while holding the write lock", () => {
    const { repo, clock } = setup();
    repo.planReminder(plan(), "plan-1");
    expect(clock.readsInsideLock).toEqual([true]);
  });
  it("keeps one reminder per collaboration, step and due-date version", () => {
    const { db, repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1").proposals[0]!;
    clock.at = laNoon("2026-11-11");
    const again = repo.planReminder(plan(clockEvent({ sourceRef: "synthetic-posting-clock-v2" })), "plan-2").proposals[0]!;
    expect(first).toMatchObject({ created: true, intent: { step: "due-minus-2", channel: "creator-message", state: "proposed", sends: false } });
    expect(again).toMatchObject({ created: false, intent: { intentRef: first.intent.intentRef } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM creator_follow_up_intents").get()?.n).toBe(1);
  });
  it("treats a changed due date as a new version and supersedes the unsent older reminder", () => {
    const { repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    clock.at = laNoon("2026-11-11");
    const moved = repo.planReminder(plan(clockEvent({ dueDate: "2026-11-13" })), "plan-2").proposals[0]!;
    expect(moved).toMatchObject({ created: true, intent: { step: "due-minus-2" } });
    expect(moved.intent.dueVersion).not.toBe(first.dueVersion);
    expect(repo.intent(first.intentRef)).toMatchObject({ state: "superseded", supersededBy: "dueDateChanged", supersededFrom: "proposed" });
    expect(repo.conflicts(collaborationId)).toEqual([]);
  });
  it("withdraws a reminder awaiting approval when the due date changes, and holds new reminders until an operator settles it", () => {
    const { repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: first.intentRef, ...approval }, "outcome-1");
    clock.at = laNoon("2026-11-11");
    const moved = repo.planReminder(plan(clockEvent({ dueDate: "2026-11-13" })), "plan-2");
    expect(repo.intent(first.intentRef)).toMatchObject({ state: "superseded", supersededBy: "dueDateChanged", supersededFrom: "awaitingApproval" });
    expect(moved).toEqual({ decision: { kind: "humanReview", reasonCodes: ["OUTCOME_CONFLICT_OPEN"] }, proposals: [] });
    const [conflict] = repo.conflicts(collaborationId);
    expect(conflict).toMatchObject({ kind: "withdrawnWhileInJ04", intentRef: first.intentRef, blocking: true, resolvedAt: null });
    repo.resolveConflict(conflict!.conflictRef, "synthetic-operator", "resolve-1");
    expect(repo.planReminder(plan(clockEvent({ dueDate: "2026-11-13" })), "plan-3").proposals[0]).toMatchObject({ created: true, intent: { step: "due-minus-2" } });
  });
  it("keeps late approval and sent outcomes after closure as conflicts and never marks the intent sent", () => {
    const { repo } = setup();
    const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    repo.close(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, "close-1");
    const lateApproval = repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, ...approval }, "outcome-1");
    const lateSent = repo.recordSendOutcome({ kind: "sent", intentRef: intent.intentRef, ...run, receiptRefs: ["synthetic-receipt"] }, "outcome-2");
    expect(lateApproval).toMatchObject({ state: "conflict", intent: { state: "superseded" }, conflict: { kind: "lateOutcome", blocking: true } });
    expect(lateSent).toMatchObject({ state: "conflict", conflict: { outcome: { kind: "sent", receiptRefs: ["synthetic-receipt"] } } });
    expect(repo.intent(intent.intentRef)).toMatchObject({ state: "superseded", supersededBy: "closure", receiptRefs: [] });
    expect(repo.conflicts(collaborationId).map(c => c.outcome?.kind)).toEqual(["approvalRecorded", "sent"]);
  });
  it("withdraws creator messages in J04 when outreach is suppressed", () => {
    const { repo } = setup();
    const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    repo.recordSendOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, ...run }, "outcome-1");
    expect(repo.planReminder(plan(clockEvent(), "suppressed"), "plan-2").decision).toEqual({ kind: "humanReview", reasonCodes: ["OUTREACH_SUPPRESSED"] });
    expect(repo.intent(intent.intentRef)).toMatchObject({ state: "superseded", supersededBy: "outreachSuppressed", supersededFrom: "dispatched" });
    expect(repo.conflicts(collaborationId)).toMatchObject([{ kind: "withdrawnWhileInJ04", intentState: "dispatched" }]);
  });
  it("moves to the within-grace step once and supersedes the unsent pre-due reminder", () => {
    const { repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    clock.at = laNoon("2026-11-13");
    expect(repo.planReminder(plan(), "plan-2").proposals[0]).toMatchObject({ created: true, intent: { step: "within-grace" } });
    expect(repo.intent(first.intentRef)).toMatchObject({ state: "superseded", supersededBy: "stepAdvanced" });
    clock.at = laNoon("2026-11-15");
    expect(repo.planReminder(plan(), "plan-3")).toMatchObject({ decision: { kind: "escalate", reminder: null }, proposals: [{ created: true, intent: { step: "past-grace", channel: "human-review" } }] });
  });
  it("holds the next step while an earlier reminder is dispatched", () => {
    const { repo, clock } = setup();
    const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    repo.recordSendOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, ...run }, "outcome-1");
    clock.at = laNoon("2026-11-13");
    expect(repo.planReminder(plan(), "plan-2")).toEqual({ decision: { kind: "humanReview", reasonCodes: ["PRIOR_SEND_IN_FLIGHT"] }, proposals: [] });
    expect(repo.intent(intent.intentRef)?.state).toBe("dispatched");
  });
  it("records nothing for a missing date and sends it to human review", () => {
    const { db, repo } = setup();
    expect(repo.planReminder(plan(clockEvent({ dueDate: null })), "plan-1")).toEqual({ decision: { kind: "humanReview", reasonCodes: ["POSTING_DEADLINE_MISSING"] }, proposals: [] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM creator_follow_up_intents").get()?.n).toBe(0);
  });
  it("replays an idempotency key and refuses its reuse for a different request", () => {
    const { repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1");
    clock.at = laNoon("2026-11-13");
    expect(repo.planReminder(plan(), "plan-1")).toEqual(first);
    expect(() => repo.planReminder(plan(clockEvent({ dueDate: "2026-11-20" })), "plan-1")).toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("never replays an uncertain send and leaves it to reconciliation", () => {
    const { repo, clock } = setup();
    const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    const refs = { intentRef: intent.intentRef, ...run };
    repo.recordSendOutcome({ kind: "uncertain", ...refs }, "outcome-1");
    expect(repo.pendingReconciliation().map(i => i.intentRef)).toEqual([intent.intentRef]);
    clock.at = laNoon("2026-11-13");
    expect(repo.planReminder(plan(), "plan-2")).toEqual({ decision: { kind: "humanReview", reasonCodes: ["PRIOR_SEND_UNCERTAIN"] }, proposals: [] });
    expect(() => repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, ...approval }, "outcome-2")).toThrow("UNCERTAIN_REQUIRES_RECONCILIATION");
    expect(() => repo.recordSendOutcome({ kind: "sent", ...refs, runRef: "another-run", receiptRefs: ["synthetic-receipt"] }, "outcome-3")).toThrow("OUTCOME_BINDING_MISMATCH");
    expect(() => repo.recordSendOutcome({ kind: "sent", ...refs, runVersion: "synthetic-run-v9", receiptRefs: ["synthetic-receipt"] }, "outcome-4")).toThrow("OUTCOME_BINDING_MISMATCH");
    expect(() => repo.recordSendOutcome({ kind: "notSent", ...refs, receiptRefs: [] }, "outcome-5")).toThrow("UNCERTAIN_REQUIRES_RECONCILIATION");
    expect(repo.recordSendOutcome({ kind: "sent", ...refs, receiptRefs: ["synthetic-receipt"] }, "outcome-6")).toMatchObject({ state: "recorded", intent: { state: "sent", receiptRefs: ["synthetic-receipt"] } });
    expect(repo.pendingReconciliation()).toEqual([]);
    expect(() => repo.recordSendOutcome({ kind: "uncertain", ...refs }, "outcome-7")).toThrow("INTENT_TERMINAL");
  });
  it("does not treat an approval as a send, and keeps a held approval separate", () => {
    const { repo } = setup();
    const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    expect(repo.recordSendOutcome({ kind: "approvalHeld", intentRef: intent.intentRef, approvalRef: null, manifestRef: null, reasonCodes: ["AUTHORITY_REQUIRED"] }, "outcome-1"))
      .toMatchObject({ intent: { state: "approvalHeld", holdReasons: ["AUTHORITY_REQUIRED"] } });
    expect(repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, ...approval }, "outcome-2"))
      .toMatchObject({ intent: { state: "awaitingApproval", receiptRefs: [], holdReasons: [] } });
  });
  it("records version-bound review and closes as posted only for the approved version", () => {
    const { repo } = setup();
    const event = (type: "submitted" | "decided", contentVersion: string) => type === "submitted"
      ? { type, contentVersion, sourceRef: "synthetic-submission" } : { type, contentVersion, outcome: "approved", reviewerRef: "synthetic-reviewer" };
    repo.recordReviewEvent(collaborationId, "synthetic-deliverable", event("submitted", "content-v1"), "review-1");
    repo.recordReviewEvent(collaborationId, "synthetic-deliverable", event("decided", "content-v1"), "review-2");
    repo.recordReviewEvent(collaborationId, "synthetic-deliverable", event("submitted", "content-v2"), "review-3");
    expect(() => repo.recordReviewEvent(collaborationId, "synthetic-deliverable", event("decided", "content-v1"), "review-4")).toThrow("REVIEW_VERSION_MISMATCH");
    expect(() => repo.close(collaborationId, { reason: "posted-verified", delivery: deliveryEvidence() }, "close-1")).toThrow("POSTED_VERSION_NOT_APPROVED");
    repo.recordReviewEvent(collaborationId, "synthetic-deliverable", event("decided", "content-v2"), "review-5");
    expect(repo.close(collaborationId, { reason: "posted-verified", delivery: deliveryEvidence() }, "close-2")).toMatchObject({ reason: "posted-verified", evidenceRef: "synthetic-publication-receipt" });
  });
  it("parses closure evidence and refuses a supplied verdict in place of terms", () => {
    const { repo } = setup();
    expect(() => repo.close(collaborationId, { reason: "posted-verified", delivery: { ...deliveryEvidence(), origin: "notion" } }, "close-1")).toThrow();
    expect(() => repo.close(collaborationId, { reason: "terms-mismatch", terms: { state: "termsMismatch", reasonCodes: ["TERMS_MISMATCH"], sourceRef: "synthetic-reply" } }, "close-2")).toThrow();
    expect(repo.close(collaborationId, { reason: "terms-mismatch", terms: { kind: "reply", text: "I charge a flat fee per post", sourceRef: "synthetic-reply" } }, "close-3"))
      .toMatchObject({ reason: "terms-mismatch", reasonCodes: expect.arrayContaining(["CREATOR_FEE_REQUEST"]) });
  });
  it("stops reminders after closure and keeps one closure reason", () => {
    const { repo } = setup();
    const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
    repo.close(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, "close-1");
    expect(repo.intent(intent.intentRef)?.state).toBe("superseded");
    expect(repo.planReminder(plan(), "plan-2").decision).toEqual({ kind: "notApplicable", reasonCodes: ["FOLLOW_UP_CLOSED"], suggestedClosure: null });
    expect(() => repo.close(collaborationId, { reason: "cancelled", sourceRef: "synthetic-cancel" }, "close-2")).toThrow("FOLLOW_UP_ALREADY_CLOSED");
    expect(repo.closure(collaborationId)?.reason).toBe("declined");
  });
  it("raises one rights expiry warning per rights binding, dated in the configured timezone", () => {
    // 05:00 UTC on 21 November is still 20 November in Los Angeles.
    const { repo, clock } = setup(Date.parse("2026-11-21T05:00:00.000Z"));
    const asset = storedAsset();
    const input = { scope: assetTestScope, asset, use: syntheticUse(), chain: [{ asset, rights: syntheticRights(asset, { validUntil: "2026-12-31T00:00:00.000Z" }) }] };
    const first = repo.recordRightsCheck(collaborationId, input, "rights-1");
    clock.at += 86_400_000;
    const second = repo.recordRightsCheck(collaborationId, input, "rights-2");
    expect(first).toMatchObject({ gate: { paidReuse: "allowed", expiry: { state: "warning" } },
      proposal: { created: true, intent: { step: "rights-expiry-warning", channel: "human-review", localDay: "2026-11-20", timezone: "America/Los_Angeles" } } });
    expect(second).toMatchObject({ proposal: { created: false, intent: { intentRef: first.proposal!.intent.intentRef } } });
    clock.at = Date.parse("2026-12-02T00:00:00.000Z");
    expect(repo.recordRightsCheck(collaborationId, input, "rights-3").gate).toMatchObject({ paidReuse: "blocked", rightsStatus: "expired" });
  });
  it("rolls back a refused write without recording its key", () => {
    const { db, repo } = setup();
    expect(() => repo.close(collaborationId, { reason: "expired", event: clockEvent() }, "close-1")).toThrow("POSTING_GRACE_NOT_ELAPSED");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM creator_follow_up_requests").get()?.n).toBe(0);
  });
});
