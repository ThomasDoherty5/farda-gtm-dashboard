// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import type { StoredAsset } from "../assets.ts";
import { assetTestNow, assetTestScope, syntheticAsset, syntheticChecksum, syntheticRights, syntheticUse } from "../assetTestFixtures.ts";
import { FollowUpRepository } from "./repository.ts";
import { clockEvent, collaborationId, deliveryEvidence, followUpConfig, followUpDatabase, followUpScope, laNoon } from "./fixtures.testkit.ts";

function setup(start = laNoon("2026-11-10")) {
  const db = followUpDatabase(), clock = { at: start, readsInsideLock: [] as boolean[] };
  const repo = new FollowUpRepository(db, followUpScope, followUpConfig, () => { clock.readsInsideLock.push(db.isTransaction); return clock.at; });
  return { db, repo, clock };
}
const plan = (event = clockEvent()) => ({ event, collaborationId, outreach: "clear" as const, postedVerified: false });

describe("follow-up repository", () => {
  it("binds to the shared agent database scope", () => {
    const db = followUpDatabase({ ...followUpScope, accountId: "other-account" });
    expect(() => new FollowUpRepository(db, followUpScope, followUpConfig)).toThrow("DATABASE_SCOPE_MISMATCH");
  });
  it("reads the injected clock only while holding the write lock", () => {
    const { repo, clock } = setup();
    repo.planReminder(plan(), "plan-1");
    expect(clock.readsInsideLock).toEqual([true]);
  });
  it("keeps one reminder per collaboration, step and due-date version", () => {
    const { db, repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1");
    clock.at = laNoon("2026-11-11");
    const again = repo.planReminder(plan(clockEvent({ sourceRef: "synthetic-posting-clock-v2" })), "plan-2");
    expect(first).toMatchObject({ created: true, intent: { step: "due-minus-2", channel: "creator-message", state: "proposed", sends: false } });
    expect(again).toMatchObject({ created: false, intent: { intentRef: first.intent!.intentRef } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM creator_follow_up_intents").get()?.n).toBe(1);
  });
  it("treats a changed due date as a new version and supersedes the unsent older reminder", () => {
    const { repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1");
    clock.at = laNoon("2026-11-11");
    const moved = repo.planReminder(plan(clockEvent({ dueDate: "2026-11-13" })), "plan-2");
    expect(moved).toMatchObject({ created: true, intent: { step: "due-minus-2" } });
    expect(moved.intent!.dueVersion).not.toBe(first.intent!.dueVersion);
    expect(repo.intent(first.intent!.intentRef)?.state).toBe("superseded");
  });
  it("moves to the within-grace step once and supersedes the unsent pre-due reminder", () => {
    const { repo, clock } = setup();
    const first = repo.planReminder(plan(), "plan-1");
    clock.at = laNoon("2026-11-13");
    const grace = repo.planReminder(plan(), "plan-2");
    expect(grace).toMatchObject({ created: true, intent: { step: "within-grace" } });
    expect(repo.intent(first.intent!.intentRef)?.state).toBe("superseded");
    clock.at = laNoon("2026-11-15");
    expect(repo.planReminder(plan(), "plan-3")).toMatchObject({ created: true, decision: { kind: "escalate" }, intent: { step: "past-grace", channel: "human-review" } });
  });
  it("records nothing for a missing date and sends it to human review", () => {
    const { db, repo } = setup();
    expect(repo.planReminder(plan(clockEvent({ dueDate: null })), "plan-1")).toEqual({ decision: { kind: "humanReview", reasonCodes: ["POSTING_DEADLINE_MISSING"] }, intent: null, created: false });
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
    const intent = repo.planReminder(plan(), "plan-1").intent!;
    const refs = { intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic", runRef: "synthetic-run", runVersion: "synthetic-run-v1" };
    repo.recordSendOutcome({ kind: "uncertain", ...refs }, "outcome-1");
    expect(repo.pendingReconciliation().map(i => i.intentRef)).toEqual([intent.intentRef]);
    clock.at = laNoon("2026-11-13");
    expect(repo.planReminder(plan(), "plan-2")).toEqual({ decision: { kind: "humanReview", reasonCodes: ["PRIOR_SEND_UNCERTAIN"] }, intent: null, created: false });
    expect(() => repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" }, "outcome-2"))
      .toThrow("UNCERTAIN_REQUIRES_RECONCILIATION");
    expect(() => repo.recordSendOutcome({ kind: "sent", ...refs, runRef: "another-run", receiptRefs: ["synthetic-receipt"] }, "outcome-3")).toThrow("OUTCOME_BINDING_MISMATCH");
    expect(() => repo.recordSendOutcome({ kind: "notSent", ...refs, receiptRefs: [] }, "outcome-4")).toThrow("UNCERTAIN_REQUIRES_RECONCILIATION");
    expect(repo.recordSendOutcome({ kind: "sent", ...refs, receiptRefs: ["synthetic-receipt"] }, "outcome-5")).toMatchObject({ state: "sent", receiptRefs: ["synthetic-receipt"] });
    expect(repo.pendingReconciliation()).toEqual([]);
    expect(() => repo.recordSendOutcome({ kind: "uncertain", ...refs }, "outcome-6")).toThrow("INTENT_TERMINAL");
  });
  it("does not treat an approval as a send", () => {
    const { repo } = setup();
    const intent = repo.planReminder(plan(), "plan-1").intent!;
    expect(repo.recordSendOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "synthetic-approval", manifestRef: "manifest-synthetic" }, "outcome-1"))
      .toMatchObject({ state: "awaitingApproval", receiptRefs: [] });
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
  it("stops reminders after closure and keeps one closure reason", () => {
    const { repo } = setup();
    const intent = repo.planReminder(plan(), "plan-1").intent!;
    repo.close(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, "close-1");
    expect(repo.intent(intent.intentRef)?.state).toBe("superseded");
    expect(repo.planReminder(plan(), "plan-2").decision).toEqual({ kind: "notApplicable", reasonCodes: ["FOLLOW_UP_CLOSED"], suggestedClosure: null });
    expect(() => repo.close(collaborationId, { reason: "cancelled", sourceRef: "synthetic-cancel" }, "close-2")).toThrow("FOLLOW_UP_ALREADY_CLOSED");
    expect(repo.closure(collaborationId)?.reason).toBe("declined");
  });
  it("raises one rights expiry warning per rights binding, evaluated at the locked clock", () => {
    const { repo, clock } = setup(Date.parse("2026-11-20T12:00:00.000Z"));
    const asset: StoredAsset = { submission: syntheticAsset(), version: 1, recordedAt: assetTestNow, submissionHash: digest(syntheticAsset()), storageIdentity: "synthetic-storage",
      sourceEvidence: { scope: assetTestScope, submissionHash: digest(syntheticAsset()), observedAt: assetTestNow, authorizationRef: "synthetic-source", availability: "available", checksum: syntheticChecksum } };
    const input = { scope: assetTestScope, asset, use: syntheticUse(), chain: [{ asset, rights: syntheticRights(asset, { validUntil: "2026-12-31T00:00:00.000Z" }) }] };
    const first = repo.recordRightsCheck(collaborationId, input, "rights-1");
    clock.at += 86_400_000;
    const second = repo.recordRightsCheck(collaborationId, input, "rights-2");
    expect(first).toMatchObject({ created: true, gate: { paidReuse: "allowed", expiry: { state: "warning" } }, intent: { step: "rights-expiry-warning", channel: "human-review" } });
    expect(second).toMatchObject({ created: false, intent: { intentRef: first.intent!.intentRef } });
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
