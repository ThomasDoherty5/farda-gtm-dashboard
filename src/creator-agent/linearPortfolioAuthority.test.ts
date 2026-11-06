// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinearPortfolioAuthority } from "./linearPortfolioAuthority.ts";
import { sourceFixture, sourceIds, sourceLocator, sourceTestNow } from "./portfolioSourceTestFixtures.ts";
import { PORTFOLIO_TEST_SCOPE as scope } from "./portfolioTestFixtures.ts";

describe("scoped Linear and J04 portfolio authority", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(sourceTestNow)); });
  afterEach(() => vi.useRealTimers());
  it("reads only the configured official endpoint and binds affirmative review request to its exact source manifest", async () => {
    const f = sourceFixture();
    const receipt = await f.authority().resolveOnDemandApproval(sourceLocator, f.manifest.eventId, scope);
    expect(receipt).toMatchObject({ scope, approved: true, eventId: f.manifest.eventId, binding: f.manifest.binding, linearProof: { issueId: sourceIds.issue, commentId: sourceIds.comment, j04ReceiptRef: f.origin.sourceRef } });
    expect(f.requests).toHaveLength(2);
    for (const call of f.requests) {
      expect(call).toMatchObject({ url: "https://api.linear.app/graphql", options: { method: "POST", redirect: "error", credentials: "omit", cache: "no-store" } });
      const body = JSON.parse(String(call.options?.body));
      expect(body.variables).toEqual({ id: sourceIds.issue });
      expect(body.query).toMatch(/^query PortfolioReceipt/);
      expect(body.query).not.toMatch(/mutation/);
    }
  });
  it.each([
    ["foreign workspace", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.organization.id = sourceIds.other; }],
    ["foreign team", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.team.id = sourceIds.other; }],
    ["wrong issue", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.id = sourceIds.other; }],
    ["archived issue", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.archivedAt = sourceTestNow; }],
    ["trashed issue", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.trashed = true; }],
    ["cancelled issue", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.state.type = "canceled"; }],
    ["unverified founder", (f: ReturnType<typeof sourceFixture>) => { f.comment.user.id = sourceIds.other; }],
    ["deactivated user", (f: ReturnType<typeof sourceFixture>) => { f.comment.user.active = false; }],
    ["delegated comment", (f: ReturnType<typeof sourceFixture>) => { f.comment.onBehalfOf = { id: sourceIds.founder }; }],
    ["edited comment", (f: ReturnType<typeof sourceFixture>) => { f.comment.editedAt = sourceTestNow; }],
    ["malformed absolute source time", (f: ReturnType<typeof sourceFixture>) => { f.comment.createdAt = "2026-11-03T00:01:00+99:99"; }],
    ["archived comment", (f: ReturnType<typeof sourceFixture>) => { f.comment.archivedAt = sourceTestNow; }],
    ["truncated issue", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.comments.pageInfo.hasNextPage = true; }],
    ["later founder message", (f: ReturnType<typeof sourceFixture>) => { f.graph.data.issue.comments.nodes.push({ ...f.comment, id: sourceIds.other, body: "Withdraw this approval", createdAt: sourceTestNow }); }],
    ["revoked J04", (f: ReturnType<typeof sourceFixture>) => { f.origin.state = "revoked"; }],
    ["J04 wrong manifest", (f: ReturnType<typeof sourceFixture>) => { f.origin.manifestDigest = "a".repeat(64); }],
    ["J04 wrong actor", (f: ReturnType<typeof sourceFixture>) => { f.origin.founderUserId = sourceIds.other; }],
    ["J04 wrong source ref", (f: ReturnType<typeof sourceFixture>) => { f.origin.sourceRef = "synthetic:different-origin"; }],
    ["expired J04", (f: ReturnType<typeof sourceFixture>) => { f.origin.validUntil = sourceTestNow; }],
    ["missing independently verified Slack origin", (f: ReturnType<typeof sourceFixture>) => { f.state.origin = null; }],
    ["Linear unavailable", (f: ReturnType<typeof sourceFixture>) => { f.state.fetchError = true; }],
  ] as const)("holds %s", async (_case, mutate) => {
    const f = sourceFixture(); mutate(f);
    expect(await f.authority().resolveOnDemandApproval(sourceLocator, f.manifest.eventId, scope)).toBeNull();
  });
  it("rechecks Linear and current expiry after the independent origin resolves", async () => {
    const f = sourceFixture(); f.state.afterOrigin = () => { f.comment.editedAt = sourceTestNow; };
    expect(await f.authority().resolveOnDemandApproval(sourceLocator, f.manifest.eventId, scope)).toBeNull();
    expect(f.requests).toHaveLength(2);
    f.comment.editedAt = null;
    f.state.afterOrigin = () => vi.setSystemTime(new Date(f.origin.validUntil));
    expect(await f.authority().resolveOnDemandApproval(sourceLocator, f.manifest.eventId, scope)).toBeNull();
  });
  it("does not fetch arbitrary locators, foreign scopes or uncredentialed records", async () => {
    const f = sourceFixture(); const a = f.authority();
    expect(await a.resolveDecision("https://example.invalid/source", scope)).toBeNull();
    expect(await a.resolveDecision(sourceLocator, { ...scope, accountId: "synthetic-foreign" })).toBeNull();
    expect(await a.resolveDecision(sourceLocator.replace(sourceIds.issue, sourceIds.other), scope)).toBeNull();
    delete f.config.credential;
    expect(await f.authority().resolveDecision(sourceLocator, scope)).toBeNull();
    expect(f.requests).toEqual([]);
    expect(await createLinearPortfolioAuthority(f.config).resolveParticipation!("synthetic:receipt", scope)).toBeNull();
  });
  it("requires the allowlisted J04 writer, actor mapping and real J04 origin when a bot persists the decision", async () => {
    const f = sourceFixture(); f.comment.botActor = { id: sourceIds.bot }; f.comment.user.id = sourceIds.other;
    expect(await f.authority().resolveOnDemandApproval(sourceLocator, f.manifest.eventId, scope)).not.toBeNull();
    f.comment.botActor.id = sourceIds.other;
    expect(await f.authority().resolveOnDemandApproval(sourceLocator, f.manifest.eventId, scope)).toBeNull();
  });
});
