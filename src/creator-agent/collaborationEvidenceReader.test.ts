// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "./store.ts";
import { PortfolioRepository } from "./portfolioStore.ts";
import { AssetRepository } from "./assetStore.ts";
import { createCollaborationEvidenceReader } from "./collaborationEvidenceReader.ts";
import { assetTestScope, assetTestNow, syntheticAsset, syntheticAssetAuthority } from "./assetTestFixtures.ts";
import { syntheticPortfolioPacket } from "./portfolioTestFixtures.ts";
import { PORTFOLIO_TEST_SCOPE } from "./portfolioTestFixtures.ts";
import { sourceFixture, sourceLocator, sourceTestNow } from "./portfolioSourceTestFixtures.ts";

const collab = "synthetic-collaboration";
const secret = "synthetic-reader-key-for-cursor-tests";
function setup() {
  const store = new AgentStore(":memory:", assetTestScope);
  const portfolio = new PortfolioRepository(store.database, assetTestScope);
  const fixture = syntheticAssetAuthority();
  const assets = new AssetRepository(store.database, assetTestScope, fixture.authority);
  let clock = Date.parse(assetTestNow);
  const read = createCollaborationEvidenceReader(store.database, assetTestScope, secret, fixture.authority, () => clock);
  return { store, portfolio, assets, read, fixture, advance: () => { clock += 16 * 60_000; } };
}
describe("exact collaboration evidence reads", () => {
  it("distinguishes a confirmed empty local registry from unknown rights", async () => {
    const s = setup();
    try {
      expect((await s.read({ collaborationId: collab, cursor: null, limit: 25 })).data).toMatchObject({ records: [], total: 0, hasMore: false });
      s.fixture.state.rights.set("synthetic-asset", null);
      await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset() }, "asset1");
      const result = await s.read({ collaborationId: collab, cursor: null, limit: 25 });
      expect(result.data.records[0]).toMatchObject({ kind: "asset", rightsState: "unknown", reviewState: "unknown" });
      expect(JSON.stringify(result)).not.toMatch(/synthetic-object|authorizationRef|checksum|https/);
    } finally { s.store.close(); }
  });
  it("keeps versions and derivative identity, excluding the same creator's other collaboration", async () => {
    const s = setup();
    try {
      await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset() }, "asset1");
      await s.assets.ingest({ scope: assetTestScope, expectedVersion: 1, submission: syntheticAsset({ fileVersion: "file-v2" }) }, "asset2");
      await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset({ assetId: "other-asset", collaborationId: "other-collaboration" }) }, "asset3");
      const records = (await s.read({ collaborationId: collab, cursor: null, limit: 25 })).data.records;
      expect(records.map(r => r.kind === "asset" ? [r.assetId, r.version] : null)).toEqual([["synthetic-asset", 1], ["synthetic-asset", 2]]);
    } finally { s.store.close(); }
  });
  it("pins page membership while later records arrive and rejects context changes", async () => {
    const s = setup();
    try {
      for (let i = 0; i < 3; i++) await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset({ assetId: `asset-${i}` }) }, `ingest-${i}`);
      const first = await s.read({ collaborationId: collab, cursor: null, limit: 1 });
      await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset({ assetId: "asset-000-new" }) }, "new-asset");
      const second = await s.read({ collaborationId: collab, cursor: first.nextCursor, limit: 1 });
      const third = await s.read({ collaborationId: collab, cursor: second.nextCursor, limit: 1 });
      expect([first, second, third].flatMap(p => p.data.records.map(r => r.kind === "asset" ? r.assetId : null))).toEqual(["asset-0", "asset-1", "asset-2"]);
      expect(third.data.total).toBe(3); expect(third.nextCursor).toBeNull();
      await expect(s.read({ collaborationId: "other", cursor: first.nextCursor, limit: 1 })).rejects.toThrow("INVALID_EVIDENCE_CURSOR");
      await expect(s.read({ collaborationId: collab, cursor: first.nextCursor, limit: 2 })).rejects.toThrow("INVALID_EVIDENCE_CURSOR");
      await expect(s.read({ collaborationId: collab, cursor: `${first.nextCursor}bad`, limit: 1 })).rejects.toThrow("INVALID_EVIDENCE_CURSOR");
      s.advance(); await expect(s.read({ collaborationId: collab, cursor: first.nextCursor, limit: 1 })).rejects.toThrow("EVIDENCE_CURSOR_EXPIRED");
    } finally { s.store.close(); }
  });
  it("returns current rights only for the exact bound version and valid observation", async () => {
    const s = setup();
    try {
      await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset() }, "asset1");
      expect((await s.read({ collaborationId: collab, cursor: null, limit: 25 })).data.records[0]).toMatchObject({ rightsState: "granted", reviewState: "accepted" });
      s.fixture.state.rights.set("synthetic-asset", { scope: { workspaceId: "foreign", accountId: "foreign" } });
      expect((await s.read({ collaborationId: collab, cursor: null, limit: 25 })).data.records[0]).toMatchObject({ rightsState: "unknown" });
      s.fixture.state.rights.set("synthetic-asset", { validUntil: assetTestNow });
      expect((await s.read({ collaborationId: collab, cursor: null, limit: 25 })).data.records[0]).toMatchObject({ rightsState: "unknown" });
    } finally { s.store.close(); }
  });
  it("uses exact reviewed collaboration membership and treats historical provenance as unverified", async () => {
    const s = setup();
    try {
      const packet = syntheticPortfolioPacket();
      packet.creators[0]!.collaborations[0]!.collaborationId = collab;
      const record = await s.portfolio.review({ scope: assetTestScope, expectedVersion: 0, packet }, "review1");
      expect((await s.read({ collaborationId: collab, cursor: null, limit: 25 })).data.records).toEqual([expect.objectContaining({ kind: "review", creatorId: "synthetic-creator", reviewKey: record.reviewKey, sourceVerified: false })]);
      expect((await s.read({ collaborationId: "same-creator-but-other", cursor: null, limit: 25 })).data.total).toBe(0);
    } finally { s.store.close(); }
  });
  it("rejects a foreign scope at construction", () => {
    const s = setup();
    try { expect(() => createCollaborationEvidenceReader(s.store.database, { workspaceId: "foreign", accountId: "foreign" }, secret)).toThrow("DATABASE_SCOPE_MISMATCH"); }
    finally { s.store.close(); }
  });
  it("projects verified decisions and participation only for their exact original or next collaboration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(sourceTestNow));
    const store = new AgentStore(":memory:", PORTFOLIO_TEST_SCOPE);
    try {
      const f = sourceFixture();
      const repo = new PortfolioRepository(store.database, PORTFOLIO_TEST_SCOPE, f.authority());
      new AssetRepository(store.database, PORTFOLIO_TEST_SCOPE);
      const review = await repo.review({ scope: PORTFOLIO_TEST_SCOPE, expectedVersion: 0, packet: f.packet }, "verified-review");
      f.decisionFor(review);
      const decision = await repo.decide(review.reviewKey, { scope: PORTFOLIO_TEST_SCOPE, expectedVersion: review.revision,
        reviewHash: review.reviewHash, linearDecisionRef: sourceLocator }, "verified-decision");
      const input = { scope: PORTFOLIO_TEST_SCOPE, decisionId: decision.decisionId, creatorId: "synthetic-creator", state: "accepted" as const,
        nextCollaborationIds: ["synthetic-next-collaboration"], sourceReceiptRef: "synthetic-native-acceptance", occurredAt: sourceTestNow, outcomeRefs: [] };
      f.state.participation = { reviewKey: review.reviewKey, participation: input };
      await repo.recordParticipation(review.reviewKey, input, "verified-participation");
      const read = createCollaborationEvidenceReader(store.database, PORTFOLIO_TEST_SCOPE, secret);
      const original = (await read({ collaborationId: "synthetic-creator-collaboration", cursor: null, limit: 25 })).data;
      expect(original.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "review", sourceVerified: true }), expect.objectContaining({ kind: "decision", decision: "approved" }),
        expect.objectContaining({ kind: "participation", sourceReceiptRef: expect.stringMatching(/^evidence:[a-f0-9]{64}$/), sourceVerified: true }),
      ]));
      expect((await read({ collaborationId: "synthetic-next-collaboration", cursor: null, limit: 25 })).data.records).toEqual([expect.objectContaining({ kind: "participation" })]);
      expect((await read({ collaborationId: "unrelated-collaboration", cursor: null, limit: 25 })).data.total).toBe(0);
      const unsafe = "https://private.invalid/file?token=synthetic-private-value";
      store.database.prepare("UPDATE portfolio_decisions SET body=json_set(body,'$.linearDecisionRef',?)").run(unsafe);
      store.database.prepare("UPDATE portfolio_participation SET body=json_set(body,'$.sourceReceiptRef',?)").run(unsafe);
      expect(JSON.stringify((await read({ collaborationId: "synthetic-creator-collaboration", cursor: null, limit: 25 })).data)).not.toContain("synthetic-private-value");
      store.database.prepare("UPDATE portfolio_decisions SET body=json_remove(body,'$.sourceMode')").run();
      const historical = (await read({ collaborationId: "synthetic-next-collaboration", cursor: null, limit: 25 })).data.records;
      expect(historical).toEqual([expect.objectContaining({ kind: "participation", sourceVerified: false })]);
    } finally { store.close(); vi.useRealTimers(); }
  });
  it("rechecks rights expiry after a slow adjacent asset observation completes", async () => {
    const s = setup();
    try {
      for (const assetId of ["first", "slow"]) await s.assets.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset({ assetId }) }, assetId);
      let clock = Date.parse(assetTestNow);
      const original = s.fixture.authority.currentRights;
      const authority = { ...s.fixture.authority, currentRights: async (...args: Parameters<typeof original>) => {
        if (args[0].submission.assetId === "slow") { await new Promise(resolve => setTimeout(resolve, 1)); clock += 2000; }
        const rights = await original(...args);
        return args[0].submission.assetId === "first" && rights ? { ...rights, validUntil: "2026-11-04T12:00:01.000Z" } : rights;
      } };
      const read = createCollaborationEvidenceReader(s.store.database, assetTestScope, secret, authority, () => clock);
      const records = (await read({ collaborationId: collab, cursor: null, limit: 25 })).data.records;
      expect(records).toEqual([expect.objectContaining({ assetId: "first", rightsState: "unknown" }), expect.objectContaining({ assetId: "slow", rightsState: "granted" })]);
    } finally { s.store.close(); }
  });
});
