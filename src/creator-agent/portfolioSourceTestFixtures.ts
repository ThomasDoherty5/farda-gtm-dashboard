// Synthetic native-provider responses used only by tests.
import { digest } from "./config.ts";
import { createLinearPortfolioAuthority, type LinearPortfolioConfig, type LinearPortfolioManifest, type PortfolioJ04Origin } from "./linearPortfolioAuthority.ts";
import { portfolioSourceBinding } from "./portfolioSources.ts";
import type { StoredPortfolioReview, VerifiedPortfolioParticipation } from "./portfolioStore.ts";
import { PORTFOLIO_TEST_SCOPE as scope, syntheticPortfolioPacket } from "./portfolioTestFixtures.ts";

export const sourceTestNow = "2026-11-04T12:00:00.000Z";
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export const sourceIds = { org: id(1), team: id(2), issue: id(3), comment: id(4), founder: id(5), bot: id(6), other: id(7) };
export const sourceLocator = ["linear", sourceIds.issue, sourceIds.comment].join(":");

export function sourceFixture() {
  const packet = syntheticPortfolioPacket();
  packet.reviewWindow = { start: "2026-10-26T07:00:00Z", end: "2026-11-02T08:00:00Z" };
  packet.creators[0]!.collaborations[0]!.posts[0]!.publishedAt = "2026-10-18T00:00:00Z";
  packet.trigger = { kind: "weekly-performance-review", sourceRef: "synthetic:weekly-snapshot", eventId: "synthetic:weekly-event" };
  const snapshot = { scope, sourceRef: packet.trigger.sourceRef, eventId: packet.trigger.eventId, snapshotVersion: "synthetic-v1",
    sealedAt: "2026-11-02T16:30:00Z", binding: portfolioSourceBinding(packet) };
  const demandPacket = structuredClone(packet);
  demandPacket.trigger = { kind: "approved-on-demand", approvalRef: sourceLocator, eventId: "synthetic:review-request" };
  const base = { schemaVersion: "farda.portfolio.linear.v1" as const, issueId: sourceIds.issue, scope, founderUserId: sourceIds.founder,
    j04ReceiptRef: "synthetic:j04-origin", decidedAt: "2026-11-03T00:00:00Z", expiresAt: "2026-11-05T00:00:00Z" };
  const manifest: LinearPortfolioManifest = { ...base, kind: "review-request", eventId: demandPacket.trigger.eventId, approved: true, binding: portfolioSourceBinding(demandPacket) };
  const comment = { id: sourceIds.comment, issueId: sourceIds.issue, body: JSON.stringify(manifest), createdAt: "2026-11-03T00:01:00Z",
    editedAt: null as string | null, archivedAt: null as string | null, parentId: null as string | null,
    user: { id: sourceIds.founder, active: true }, botActor: null as { id: string } | null, onBehalfOf: null as { id: string } | null,
    externalUser: null as { id: string } | null, agentSession: null as { id: string } | null };
  const graph = { data: { organization: { id: sourceIds.org }, issue: { id: sourceIds.issue, team: { id: sourceIds.team }, archivedAt: null as string | null,
    trashed: false, state: { type: "started" }, comments: { nodes: [comment], pageInfo: { hasNextPage: false } } } } };
  const origin: PortfolioJ04Origin = { scope, sourceRef: base.j04ReceiptRef, linearRef: sourceLocator, manifestDigest: digest(manifest),
    founderUserId: sourceIds.founder, origin: "slack-thread", slackWorkspaceRef: "synthetic:slack-workspace", slackChannelRef: "synthetic:slack-channel",
    slackThreadRef: "synthetic:slack-thread", slackEventRef: "synthetic:slack-event", decision: "approved", state: "current",
    decidedAt: base.decidedAt, checkedAt: sourceTestNow, validUntil: base.expiresAt };
  const config: LinearPortfolioConfig = { scope, organizationId: sourceIds.org, teamId: sourceIds.team, issueIds: [sourceIds.issue],
    founderUserIds: [sourceIds.founder], j04WriterBotIds: [sourceIds.bot], credential: { kind: "api-key", value: "synthetic-test-only" }, approvedLaunchAt: "2026-10-28T17:00:00Z" };
  const state = { snapshot: snapshot as typeof snapshot | null, origin: origin as PortfolioJ04Origin | null, participation: null as VerifiedPortfolioParticipation | null,
    afterOrigin: undefined as (() => void) | undefined, fetchError: false };
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const authority = () => createLinearPortfolioAuthority(config, {
    resolveWeeklySnapshot: async () => structuredClone(state.snapshot),
    resolveJ04Origin: async () => { state.afterOrigin?.(); return structuredClone(state.origin); },
    resolveParticipation: async () => structuredClone(state.participation),
  }, { now: () => Date.now(), fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    if (state.fetchError) throw new Error("synthetic-private-provider-message");
    return Response.json(graph);
  } });
  function decisionFor(review: StoredPortfolioReview) {
    const decision: LinearPortfolioManifest = { ...base, kind: "decision", reviewKey: review.reviewKey, revision: review.revision, reviewHash: review.reviewHash,
      decision: "approved", creatorDecisions: review.proposal.recommendations.map(({ creatorId, action }) => ({ creatorId, action })) };
    comment.body = JSON.stringify(decision);
    state.origin = { ...origin, manifestDigest: digest(decision) };
  }
  return { config, packet, snapshot, demandPacket, manifest, comment, graph, origin, state, requests, authority, decisionFor };
}
