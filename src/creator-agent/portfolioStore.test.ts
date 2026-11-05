// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { PortfolioRepository, type PortfolioDecisionAuthority, type StoredPortfolioReview, type VerifiedPortfolioDecision, type VerifiedPortfolioParticipation } from "./portfolioStore.ts";
import { PORTFOLIO_TEST_SCOPE as scope, observedPortfolioNumber as number, syntheticPortfolioPacket } from "./portfolioTestFixtures.ts";

describe("persistent portfolio review, decision authority and repeat participation", () => {
  let directory: string;
  let store: AgentStore;
  let repository: PortfolioRepository;
  let decision: VerifiedPortfolioDecision | null;
  const participationReceipts = new Map<string, VerifiedPortfolioParticipation>();
  const authority: PortfolioDecisionAuthority = { resolveDecision: async () => decision, resolveOnDemandApproval: async () => false, resolveParticipation: async (ref) => participationReceipts.get(ref) ?? null };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "synthetic-portfolio-test-"));
    store = new AgentStore(join(directory, "agent.sqlite"), scope);
    decision = null;
    participationReceipts.clear();
    repository = new PortfolioRepository(store.database, scope, authority);
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const write = (packet = syntheticPortfolioPacket(), expectedVersion = 0, key = "synthetic-review-1") => repository.review({ scope, expectedVersion, packet }, key);
  function verified(review: StoredPortfolioReview): VerifiedPortfolioDecision {
    return { linearDecisionRef: "synthetic:linear-decision", reviewKey: review.reviewKey, revision: review.revision, reviewHash: review.reviewHash, decision: "approved", decidedAt: "2026-11-04T01:00:00Z", founderRef: "synthetic:founder", creatorDecisions: review.proposal.recommendations.map(({ creatorId, action }) => ({ creatorId, action })) };
  }
  const decisionBody = (review: StoredPortfolioReview) => ({ scope, expectedVersion: review.revision, reviewHash: review.reviewHash, linearDecisionRef: "synthetic:linear-decision" });
  function participation(reviewKey: string, input: VerifiedPortfolioParticipation["participation"], key: string) {
    participationReceipts.set(input.sourceReceiptRef, { reviewKey, participation: input });
    return repository.recordParticipation(reviewKey, input, key);
  }

  it("persists in the existing scoped database, survives restart, and deduplicates a source event across request keys", async () => {
    const first = await write();
    expect(await write()).toEqual(first);
    expect(await write(syntheticPortfolioPacket(), 0, "synthetic-duplicate-event")).toEqual(first);
    store.close();
    store = new AgentStore(join(directory, "agent.sqlite"), scope);
    repository = new PortfolioRepository(store.database, scope, authority);
    expect(repository.latest(first.reviewKey)).toEqual(first);
    expect(repository.history(first.reviewKey).reviews).toEqual([first]);
    expect(store.listLatest().total).toBe(0);
  });
  it("rejects scope mismatch before replay and refuses a differently scoped repository", async () => {
    const packet = syntheticPortfolioPacket();
    await write(packet);
    await expect(repository.review({ scope: { ...scope, accountId: "synthetic-other-account" }, expectedVersion: 0, packet }, "synthetic-review-1")).rejects.toThrow("PORTFOLIO_SCOPE_MISMATCH");
    expect(() => new PortfolioRepository(store.database, { ...scope, workspaceId: "synthetic-other-workspace" })).toThrow("DATABASE_SCOPE_MISMATCH");
  });
  it("rejects changed retries, reused source events/revisions, and conflicting versions", async () => {
    const first = await write();
    const next = syntheticPortfolioPacket(); next.creators[0]!.collaborations[0]!.acceptedUsableAssets = number(2);
    await expect(write(next)).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(write(next, 1, "synthetic-event-reuse")).rejects.toThrow("REVIEW_EVENT_REUSED");
    next.trigger.eventId = "synthetic-new-event";
    await expect(write(next, 0, "synthetic-version-conflict")).rejects.toThrow("VERSION_CONFLICT");
    await expect(write(next, 1, "synthetic-revision-reuse")).rejects.toThrow("EVIDENCE_REVISION_REUSED");
    expect(repository.history(first.reviewKey).reviews).toEqual([first]);
  });
  it("does not accept a client self-asserted approval or an unverified on-demand event", async () => {
    const first = await write();
    await expect(repository.decide(first.reviewKey, { ...decisionBody(first), approved: true }, "synthetic-forged")).rejects.toThrow();
    await expect(repository.decide(first.reviewKey, decisionBody(first), "synthetic-no-authority")).rejects.toThrow("LINEAR_DECISION_UNVERIFIED");
    const packet = syntheticPortfolioPacket(); packet.trigger = { kind: "approved-on-demand", eventId: "synthetic-demand", approvalRef: "synthetic:unverified" };
    await expect(write(packet, 1, "synthetic-demand")).rejects.toThrow("ON_DEMAND_APPROVAL_UNVERIFIED");
    const defaultRepository = new PortfolioRepository(store.database, scope);
    await expect(defaultRepository.decide(first.reviewKey, decisionBody(first), "synthetic-default-authority")).rejects.toThrow("LINEAR_DECISION_UNVERIFIED");
  });
  it("accepts a verified exact decision as awaiting the existing workflow, never as dispatched", async () => {
    const first = await write(); decision = verified(first);
    const recorded = await repository.decide(first.reviewKey, decisionBody(first), "synthetic-decision");
    expect(recorded).toMatchObject({ executionState: "approved-awaiting-existing-workflow", dispatchAuthorized: false, handoffs: [{ creatorId: "synthetic-creator", jobs: ["J03", "J04", "J05/J06", "J07"] }] });
    expect(await repository.decide(first.reviewKey, decisionBody(first), "synthetic-decision")).toEqual(recorded);
    expect(repository.history(first.reviewKey).decisions).toEqual([recorded]);
    decision = { ...decision, reviewHash: "0".repeat(64) };
    await expect(repository.decide(first.reviewKey, decisionBody(first), "synthetic-wrong-authority-hash")).rejects.toThrow("DECISION_SCOPE_MISMATCH");
  });
  it("rejects stale approvals and preserves the old decision when late refunds change a recommendation", async () => {
    const packet = syntheticPortfolioPacket(); packet.objective = "retained-sales";
    packet.creators[0]!.collaborations[0]!.retainedContribution.cents = number(10000);
    const first = await write(packet); decision = verified(first);
    const approved = await repository.decide(first.reviewKey, decisionBody(first), "synthetic-before-refund");
    packet.evidenceRevision = "synthetic-refund-v2"; packet.trigger.eventId = "synthetic-refund-event";
    packet.creators[0]!.collaborations[0]!.retainedContribution.cents = number(-3000);
    packet.creators[0]!.collaborations[0]!.retainedContribution.adjustmentRefs = ["synthetic:late-refund"];
    const revised = await write(packet, 1, "synthetic-refund-review");
    expect(revised.proposal.recommendations[0]!.action).toBe("new-brief");
    expect(first.proposal.recommendations[0]!.action).toBe("renew");
    expect(repository.history(first.reviewKey)).toMatchObject({ reviews: [first, revised], decisions: [approved] });
    await expect(repository.decide(first.reviewKey, decisionBody(first), "synthetic-stale-approval")).rejects.toThrow("STALE_PORTFOLIO_DECISION");
    expect(await repository.decide(first.reviewKey, decisionBody(first), "synthetic-before-refund")).toEqual(approved);
  });
  it("rechecks staleness after asynchronous authority resolution", async () => {
    const first = await write();
    let resolve!: (value: VerifiedPortfolioDecision) => void;
    const waiting = new PortfolioRepository(store.database, scope, { ...authority, resolveDecision: () => new Promise((done) => { resolve = done; }) });
    const pending = waiting.decide(first.reviewKey, decisionBody(first), "synthetic-await-authority");
    const next = syntheticPortfolioPacket(); next.evidenceRevision = "synthetic-next-revision"; next.trigger.eventId = "synthetic-next-event";
    await write(next, 1, "synthetic-next-review");
    resolve(verified(first));
    await expect(pending).rejects.toThrow("STALE_PORTFOLIO_DECISION");
    expect(repository.history(first.reviewKey).decisions).toEqual([]);
  });
  it("tracks accepted, activated and subsequent outcome receipts append-only with stable collaboration IDs", async () => {
    const first = await write(); decision = verified(first);
    const approved = await repository.decide(first.reviewKey, decisionBody(first), "synthetic-decision");
    const base = { scope, decisionId: approved.decisionId, creatorId: "synthetic-creator", sourceReceiptRef: "synthetic:participation-receipt", occurredAt: "2026-11-05T00:00:00Z", nextCollaborationIds: [], outcomeRefs: [] };
    await expect(participation(first.reviewKey, { ...base, state: "activated", nextCollaborationIds: ["synthetic-repeat-collab"] }, "synthetic-out-of-order")).rejects.toThrow("PARTICIPATION_TRANSITION_INVALID");
    const accepted = await participation(first.reviewKey, { ...base, state: "accepted" }, "synthetic-accepted");
    expect(await repository.recordParticipation(first.reviewKey, { ...base, state: "accepted" }, "synthetic-accepted")).toEqual(accepted);
    const activated = await participation(first.reviewKey, { ...base, state: "activated", sourceReceiptRef: "synthetic:activation-receipt", nextCollaborationIds: ["synthetic-repeat-collab"] }, "synthetic-activated");
    const outcomeInput: VerifiedPortfolioParticipation["participation"] = { ...base, state: "outcome", sourceReceiptRef: "synthetic:outcome-receipt", nextCollaborationIds: ["synthetic-repeat-collab"], outcomeRefs: ["synthetic:retained-outcome"] };
    const outcome = await participation(first.reviewKey, outcomeInput, "synthetic-outcome");
    expect(await participation(first.reviewKey, outcomeInput, "synthetic-outcome-different-request-key")).toEqual(outcome);
    expect(repository.history(first.reviewKey).participation).toEqual([accepted, activated, outcome]);
    await expect(participation(first.reviewKey, { ...outcomeInput, outcomeRefs: ["synthetic:changed-outcome"] }, "synthetic-reused-outcome-receipt")).rejects.toThrow("PARTICIPATION_RECEIPT_REUSED");
    await expect(participation(first.reviewKey, { ...base, state: "outcome", sourceReceiptRef: "synthetic:another-outcome", nextCollaborationIds: ["synthetic-unrelated-collab"], outcomeRefs: ["synthetic:outcome"] }, "synthetic-forged-next-collab")).rejects.toThrow("NEXT_COLLABORATION_CHANGED");
  });
  it("cannot activate a declined participation or a creator held outside the approved cohort", async () => {
    const first = await write(); decision = verified(first);
    const approved = await repository.decide(first.reviewKey, decisionBody(first), "synthetic-decision");
    const input: VerifiedPortfolioParticipation["participation"] = { scope, decisionId: approved.decisionId, creatorId: "synthetic-creator", sourceReceiptRef: "synthetic:decline", occurredAt: "2026-11-05T00:00:00Z", nextCollaborationIds: [], outcomeRefs: [], state: "declined" };
    await expect(repository.recordParticipation(first.reviewKey, input, "synthetic-no-native-receipt")).rejects.toThrow("PARTICIPATION_RECEIPT_UNVERIFIED");
    await participation(first.reviewKey, input, "synthetic-declined");
    await expect(participation(first.reviewKey, { ...input, state: "activated", sourceReceiptRef: "synthetic:bad-activation", nextCollaborationIds: ["synthetic-repeat"] }, "synthetic-after-declined")).rejects.toThrow("PARTICIPATION_TRANSITION_INVALID");
    await expect(participation(first.reviewKey, { ...input, sourceReceiptRef: "synthetic:bad-creator", creatorId: "synthetic-not-selected" }, "synthetic-not-selected")).rejects.toThrow("PARTICIPATION_NOT_APPROVED");
  });
});
