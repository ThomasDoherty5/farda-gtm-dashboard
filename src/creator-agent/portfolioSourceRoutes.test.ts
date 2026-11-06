// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "./config.ts";
import { AgentStore } from "./store.ts";
import { PortfolioRepository, type PortfolioDecisionAuthority, type StoredPortfolioReview } from "./portfolioStore.ts";
import { handlePortfolioRoute } from "./portfolioRoutes.ts";
import { portfolioSourceBinding } from "./portfolioSources.ts";
import { sourceFixture, sourceIds, sourceLocator, sourceTestNow } from "./portfolioSourceTestFixtures.ts";
import { PORTFOLIO_TEST_SCOPE as scope } from "./portfolioTestFixtures.ts";
import type { PortfolioPacket } from "./portfolio.ts";

describe("portfolio source provenance through the authenticated route handler", () => {
  let store: AgentStore;
  let f: ReturnType<typeof sourceFixture>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(sourceTestNow));
    store = new AgentStore(":memory:", scope); f = sourceFixture();
  });
  afterEach(() => { store.close(); vi.useRealTimers(); });
  const repository = (authority = f.authority()) => new PortfolioRepository(store.database, scope, authority);
  const writeReview = (repo: PortfolioRepository, packet: PortfolioPacket, key = "synthetic-write", expectedVersion = 0) =>
    handlePortfolioRoute({ method: "POST", role: "reviewer", path: "/v1/portfolio/reviews", idempotencyKey: key,
      body: { scope, expectedVersion, packet } }, repo);
  const decide = (repo: PortfolioRepository, review: StoredPortfolioReview, key: string) =>
    handlePortfolioRoute({ method: "POST", role: "reviewer", path: "/v1/portfolio/reviews/" + review.reviewKey + "/decisions", idempotencyKey: key,
      body: { scope, expectedVersion: review.revision, reviewHash: review.reviewHash, linearDecisionRef: sourceLocator } }, repo);

  it("persists the exact immutable weekly source, preserves replay and rejects a changed snapshot version", async () => {
    const repo = repository();
    const first = await writeReview(repo, f.packet);
    expect(first).toMatchObject({ status: 200, body: { sourceEvidence: { mode: "verified-weekly", snapshot: f.snapshot } } });
    f.state.snapshot = null;
    expect(await writeReview(repo, f.packet)).toEqual(first);
    f.state.snapshot = { ...f.snapshot, snapshotVersion: "synthetic-conflicting-version" };
    expect(await writeReview(repo, f.packet, "synthetic-new-command", 1)).toMatchObject({ status: 409, body: { code: "REVIEW_EVENT_EVIDENCE_CHANGED" } });
    f.packet.evidenceRevision = "synthetic-updated-evidence";
    f.packet.trigger.eventId = "synthetic-another-event";
    f.state.snapshot = { ...f.snapshot, eventId: f.packet.trigger.eventId, binding: portfolioSourceBinding(f.packet) };
    expect(await writeReview(repo, f.packet, "synthetic-reused-version", 1)).toMatchObject({ status: 409, body: { code: "WEEKLY_SNAPSHOT_VERSION_REUSED" } });
    expect(repo.history((first!.body as StoredPortfolioReview).reviewKey).reviews).toHaveLength(1);
  });
  it.each([
    ["missing source", "WEEKLY_SNAPSHOT_UNVERIFIED", (f: ReturnType<typeof sourceFixture>) => { f.state.snapshot = null; }],
    ["foreign scope", "PORTFOLIO_SCOPE_MISMATCH", (f: ReturnType<typeof sourceFixture>) => { f.snapshot.scope = { ...scope, workspaceId: "synthetic-other" }; }],
    ["wrong sourceRef", "WEEKLY_SNAPSHOT_BINDING_MISMATCH", (f: ReturnType<typeof sourceFixture>) => { f.snapshot.sourceRef = "synthetic-other"; }],
    ["wrong event", "WEEKLY_SNAPSHOT_BINDING_MISMATCH", (f: ReturnType<typeof sourceFixture>) => { f.snapshot.eventId = "synthetic-other"; }],
    ["different program", "WEEKLY_SNAPSHOT_BINDING_MISMATCH", (f: ReturnType<typeof sourceFixture>) => { f.packet.programId = "synthetic-other"; }],
    ["changed packet", "WEEKLY_SNAPSHOT_BINDING_MISMATCH", (f: ReturnType<typeof sourceFixture>) => { f.packet.capacity.maximumCreators.available = 93; }],
    ["unset launch", "WEEKLY_LAUNCH_GATE_CLOSED", (f: ReturnType<typeof sourceFixture>) => { f.config.approvedLaunchAt = null; }],
    ["pre-launch week sealed late", "WEEKLY_LAUNCH_GATE_CLOSED", (f: ReturnType<typeof sourceFixture>) => { f.config.approvedLaunchAt = "2026-11-02T08:00:00Z"; }],
    ["incomplete window", "WEEKLY_LAUNCH_GATE_CLOSED", (f: ReturnType<typeof sourceFixture>) => { f.packet.reviewWindow.start = "2026-10-27T07:00:00Z"; f.snapshot.binding = portfolioSourceBinding(f.packet); }],
    ["too early for Monday pre-read", "WEEKLY_LAUNCH_GATE_CLOSED", (f: ReturnType<typeof sourceFixture>) => { f.snapshot.sealedAt = "2026-11-02T16:29:59Z"; }],
    ["future source", "WEEKLY_SNAPSHOT_TIME_INVALID", (f: ReturnType<typeof sourceFixture>) => { f.snapshot.sealedAt = "2026-11-08T00:00:00Z"; }],
  ] as const)("holds %s and creates no review", async (_label, code, mutate) => {
    mutate(f);
    expect(await writeReview(repository(), f.packet)).toMatchObject({ body: { code, executionCertainty: "notApplied" } });
    expect(store.database.prepare("SELECT count(*) AS n FROM portfolio_reviews").get()?.n).toBe(0);
  });
  it("keeps sandbox history separate and requires verified provenance for source-approved handoffs", async () => {
    const sandbox = new PortfolioRepository(store.database, scope);
    const legacy = (await writeReview(sandbox, f.packet))!.body as StoredPortfolioReview;
    expect(legacy.sourceEvidence).toEqual({ mode: "reviewer-sandbox" });
    f.decisionFor(legacy);
    const live = repository();
    expect(await decide(live, legacy, "synthetic-legacy-approval")).toMatchObject({ status: 409, body: { code: "REVIEW_SOURCE_UNVERIFIED" } });
    // Same packet, source event and revision may be verified in a new immutable review.
    const verified = (await writeReview(live, f.packet, "synthetic-verified", 1))!.body as StoredPortfolioReview;
    expect(verified.revision).toBe(2);
    expect(verified.reviewHash).not.toBe(legacy.reviewHash);
    expect(live.history(verified.reviewKey).reviews).toEqual([legacy, verified]);
    f.decisionFor(verified);
    const approved = await decide(live, verified, "synthetic-live-approval");
    expect(approved).toMatchObject({ status: 200, body: { sourceMode: "source-verified", dispatchAuthorized: false, linearProof: { commentId: sourceIds.comment } } });
    f.origin.state = "revoked"; f.state.origin = { ...f.state.origin!, state: "revoked" };
    expect(await decide(live, verified, "synthetic-fresh-check")).toMatchObject({ status: 503, body: { code: "LINEAR_DECISION_UNVERIFIED" } });
    // Acknowledgment of a historical idempotent write remains exact; it never publishes or dispatches.
    expect(await decide(live, verified, "synthetic-live-approval")).toEqual(approved);
  });
  it("binds an on-demand request to the actual approved packet", async () => {
    const live = repository();
    f.demandPacket.creators[0]!.next.sampleCashCents = 9000;
    expect(await writeReview(live, f.demandPacket)).toMatchObject({ status: 409, body: { code: "ON_DEMAND_PACKET_MISMATCH" } });
    f.demandPacket.creators[0]!.next.sampleCashCents = 2500;
    expect(await writeReview(live, f.demandPacket)).toMatchObject({ status: 200, body: { sourceEvidence: { mode: "verified-on-demand", approval: { linearProof: { j04ReceiptRef: f.origin.sourceRef } } } } });
  });
  it("addresses equivalent offset representations through one persisted window and preserves old keys", async () => {
    const sandbox = new PortfolioRepository(store.database, scope);
    const first = (await writeReview(sandbox, f.packet))!.body as StoredPortfolioReview;
    f.packet.reviewWindow = { start: "2026-10-26T00:00:00-07:00", end: "2026-11-02T00:00:00-08:00" };
    f.packet.evidenceRevision = "synthetic-corrected";
    f.packet.trigger.eventId = "synthetic-corrected-event";
    f.snapshot.binding = portfolioSourceBinding(f.packet); f.snapshot.eventId = f.packet.trigger.eventId;
    const live = repository();
    expect(await writeReview(live, f.packet, "synthetic-offset-fork", 0)).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    const verified = (await writeReview(live, f.packet, "synthetic-offset-correction", 1))!.body as StoredPortfolioReview;
    expect(verified.reviewKey).toBe(first.reviewKey);
    expect(verified.proposal.reviewKey).toBe(first.proposal.reviewKey);
    expect(verified.proposal.recommendations[0]!.key).toBe(first.proposal.recommendations[0]!.key);
    expect(live.history(first.reviewKey).reviews).toEqual([first, verified]);
  });
  it("holds a late older or ambiguous seal even with an intervening on-demand revision", async () => {
    const live = repository();
    f.snapshot.sealedAt = "2026-11-03T12:00:00Z";
    f.snapshot.snapshotVersion = "synthetic-newer-snapshot";
    const original = (await writeReview(live, f.packet))!.body as StoredPortfolioReview;
    f.demandPacket.evidenceRevision = "synthetic-on-demand-evidence";
    f.manifest.binding = portfolioSourceBinding(f.demandPacket);
    f.comment.body = JSON.stringify(f.manifest); f.origin.manifestDigest = digest(f.manifest);
    const onDemand = (await writeReview(live, f.demandPacket, "synthetic-intervening", 1))!.body as StoredPortfolioReview;
    expect(onDemand.revision).toBe(2);
    f.packet.evidenceRevision = "synthetic-late-source-version";
    f.packet.trigger.eventId = "synthetic-late-event";
    f.snapshot.eventId = f.packet.trigger.eventId;
    f.snapshot.snapshotVersion = "synthetic-previously-unseen";
    f.snapshot.binding = portfolioSourceBinding(f.packet);
    for (const sealed of ["2026-11-02T16:30:00Z", "2026-11-03T12:00:00Z"]) {
      f.snapshot.sealedAt = sealed;
      expect(await writeReview(live, f.packet, "synthetic-late-" + sealed, 2)).toMatchObject({ status: 409, body: { code: "WEEKLY_SNAPSHOT_NOT_NEWER" } });
    }
    expect(live.history(original.reviewKey).reviews).toEqual([original, onDemand]);
  });
  it("returns the first receipt when a current J04 read refreshes only its permission lease", async () => {
    const live = repository();
    f.origin.validUntil = "2026-11-04T12:10:00Z";
    const initial = await writeReview(live, f.demandPacket, "synthetic-first-lease");
    expect(initial).toMatchObject({ status: 200 });
    f.origin.validUntil = "2026-11-04T12:20:00Z";
    const retry = await writeReview(live, f.demandPacket, "synthetic-refreshed-lease");
    expect(retry).toEqual(initial);
    const review = initial!.body as StoredPortfolioReview;
    f.decisionFor(review);
    f.state.origin!.validUntil = "2026-11-04T12:10:00Z";
    const decision = await decide(live, review, "synthetic-initial-decision-lease");
    f.state.origin!.validUntil = "2026-11-04T12:20:00Z";
    expect(await decide(live, review, "synthetic-fresh-decision-lease")).toEqual(decision);
    expect(live.history(review.reviewKey).decisions).toHaveLength(1);
    f.state.origin!.state = "revoked";
    expect(await decide(live, review, "synthetic-revoked-origin")).toMatchObject({ status: 503 });
  });
  it("preserves a participation receipt’s own source mode independently of its decision", async () => {
    const live = repository();
    const review = (await writeReview(live, f.packet))!.body as StoredPortfolioReview;
    f.decisionFor(review);
    const decision = (await decide(live, review, "synthetic-verified-decision"))!.body as { decisionId: string; sourceMode: string };
    expect(decision.sourceMode).toBe("source-verified");
    const input = { scope, decisionId: decision.decisionId, creatorId: f.packet.creators[0]!.creatorId, state: "accepted" as const,
      nextCollaborationIds: [], sourceReceiptRef: "synthetic:sandbox-response", occurredAt: sourceTestNow, outcomeRefs: [] };
    f.state.participation = { reviewKey: review.reviewKey, participation: input };
    const sandbox = repository({ ...f.authority(), mode: undefined });
    const saved = await sandbox.recordParticipation(review.reviewKey, input, "synthetic-sandbox-response");
    expect(saved.sourceMode).toBe("reviewer-sandbox");
    expect(live.history(review.reviewKey).participation).toEqual([saved]);
    // A fresh native read can report the same fact but cannot silently promote its historical provenance.
    expect(await live.recordParticipation(review.reviewKey, input, "synthetic-source-retry")).toEqual(saved);
  });
  it("never attributes provider participation to a legacy sandbox decision", async () => {
    const authority = f.authority();
    const sandboxAuthority: PortfolioDecisionAuthority = { resolveDecision: authority.resolveDecision, resolveOnDemandApproval: authority.resolveOnDemandApproval, resolveParticipation: authority.resolveParticipation };
    const sandbox = repository(sandboxAuthority);
    const review = (await writeReview(sandbox, f.packet))!.body as StoredPortfolioReview;
    f.decisionFor(review);
    const { decisionId } = (await decide(sandbox, review, "synthetic-sandbox-decision"))!.body as { decisionId: string };
    const input = { scope, decisionId, creatorId: f.packet.creators[0]!.creatorId, state: "accepted" as const, nextCollaborationIds: [],
      sourceReceiptRef: "synthetic:provider-response", occurredAt: sourceTestNow, outcomeRefs: [] };
    f.state.participation = { reviewKey: review.reviewKey, participation: input };
    const historical = await sandbox.recordParticipation(review.reviewKey, input, "synthetic-historical-command");
    expect(await repository().recordParticipation(review.reviewKey, input, "synthetic-historical-command")).toEqual(historical);
    const response = await handlePortfolioRoute({ method: "POST", role: "reviewer", path: "/v1/portfolio/reviews/" + review.reviewKey + "/participation",
      idempotencyKey: "synthetic-native-participation", body: input }, repository());
    expect(response).toMatchObject({ status: 409, body: { code: "PARTICIPATION_DECISION_SOURCE_UNVERIFIED" } });
  });
});
