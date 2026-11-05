// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetRepository } from "./assetStore.ts";
import { assetTestDatabase, assetTestNow, assetTestScope, syntheticAsset, syntheticAssetAuthority, syntheticUse, syntheticRights } from "./assetTestFixtures.ts";
import type { AssetAuthority } from "./assets.ts";

describe("durable scoped creator asset repository", () => {
  let db: ReturnType<typeof assetTestDatabase>;
  let repository: AssetRepository;
  let fixtures: ReturnType<typeof syntheticAssetAuthority>;
  const clock = () => assetTestNow;
  const ingest = (submission = syntheticAsset(), key = "synthetic-ingest", expectedVersion = 0) => repository.ingest({ scope: assetTestScope, expectedVersion, submission }, key);
  const use = (assetId = "synthetic-asset", version = 1) => ({ scope: assetTestScope, use: syntheticUse(assetId, version) });
  beforeEach(() => { db = assetTestDatabase(); fixtures = syntheticAssetAuthority(); repository = new AssetRepository(db, assetTestScope, fixtures.authority, clock); });
  afterEach(() => db.close());

  it("persists revisions and idempotent receipts across restart without merging identical files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synthetic-assets-")); const path = join(dir, "agent.sqlite");
    db.close(); db = assetTestDatabase(path); repository = new AssetRepository(db, assetTestScope, fixtures.authority, clock);
    try {
      const first = await ingest();
      const other = await ingest(syntheticAsset({ assetId: "synthetic-other", collaborationId: "synthetic-other-collaboration", campaignId: "synthetic-other-campaign" }), "synthetic-other");
      expect(other.storageIdentity).toBe(first.storageIdentity);
      expect(repository.list().total).toBe(2);
      db.close(); db = assetTestDatabase(path); repository = new AssetRepository(db, assetTestScope, fixtures.authority, clock);
      expect(await ingest()).toEqual(first);
      expect(repository.get("synthetic-other")?.submission.campaignId).toBe("synthetic-other-campaign");
      await expect(ingest(syntheticAsset({ hook: "Changed" }))).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); db = assetTestDatabase(); }
  });
  it("refuses cross-scope requests and storage binding", async () => {
    await expect(repository.ingest({ scope: { ...assetTestScope, accountId: "other" }, expectedVersion: 0, submission: syntheticAsset() }, "cross")).rejects.toThrow("SCOPE_DENIED");
    expect(() => new AssetRepository(db, { ...assetTestScope, workspaceId: "other" })).toThrow("DATABASE_SCOPE_MISMATCH");
    expect(repository.list().total).toBe(0);
  });
  it("defaults to unavailable authority, without trusting caller permissions", async () => {
    const unavailable = new AssetRepository(db, assetTestScope);
    await expect(unavailable.ingest({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset() }, "unavailable")).rejects.toThrow("SOURCE_AUTHORITY_UNAVAILABLE");
    await ingest();
    expect((await unavailable.eligibility(use())).reasonCodes).toContain("J09_RIGHTS_UNAVAILABLE");
    expect(repository.exports("synthetic-asset")).toHaveLength(0);
  });
  it("rejects an authority response bound to another submission", async () => {
    const authority: AssetAuthority = { ...fixtures.authority, resolveSource: async (submission, scope) => ({ ...(await fixtures.authority.resolveSource(submission, scope))!, submissionHash: "b".repeat(64) }) };
    repository = new AssetRepository(db, assetTestScope, authority, clock);
    await expect(ingest()).rejects.toThrow("SOURCE_AUTHORITY_MISMATCH");
  });
  it("stores unknown campaign/file observations but never permits their reuse", async () => {
    fixtures.state.availability = "unavailable";
    await ingest(syntheticAsset({ campaignId: null }));
    const eligibility = await repository.eligibility(use());
    expect(eligibility.reasonCodes).toEqual(expect.arrayContaining(["CAMPAIGN_ASSIGNMENT_PENDING", "SOURCE_FILE_UNAVAILABLE"]));
    await expect(repository.prepareExport(use(), "export")).rejects.toThrow("ASSET_USE_BLOCKED");
  });
  it("rechecks file availability and exact current accepted version at use time", async () => {
    const first = await ingest();
    const exp = await repository.prepareExport(use(), "export-first");
    expect(exp).toMatchObject({ state: "prepared", externalEffect: "none", eligibility: { publishingAuthorized: false } });
    fixtures.state.availability = "quarantined";
    expect((await repository.eligibility(use())).reasonCodes).toContain("SOURCE_FILE_UNAVAILABLE");
    fixtures.state.availability = "available";
    fixtures.state.checksum = "b".repeat(64);
    await expect(ingest(syntheticAsset({ hook: "New footage" }), "version-reuse", 1)).rejects.toThrow("FILE_VERSION_REUSED");
    await ingest(syntheticAsset({ fileVersion: "file-v2", submissionId: "synthetic-submission-v2" }), "version-two", 1);
    fixtures.state.rights.set("synthetic-asset", { acceptedVersion: first.version });
    expect((await repository.eligibility(use("synthetic-asset", 2))).reasonCodes).toContain("EXACT_VERSION_NOT_ACCEPTED");
    expect((await repository.eligibility(use())).reasonCodes).toContain("ASSET_SUPERSEDED");
    // A retry returns the historical preparation receipt, never a fresh permission or external effect.
    expect(await repository.prepareExport(use(), "export-first")).toEqual(exp);
  });
  it("rejects wrong product revisions and changing ownership under one asset ID", async () => {
    await ingest();
    expect((await repository.eligibility({ ...use(), use: { ...syntheticUse(), productRevision: "revision-b" } })).reasonCodes).toContain("PRODUCT_REVISION_MISMATCH");
    await expect(ingest(syntheticAsset({ collaborationId: "other" }), "owner-change", 1)).rejects.toThrow("ASSET_OWNERSHIP_IMMUTABLE");
  });
  it("preserves original-deliverable identity and enforces ancestor permissions", async () => {
    await ingest();
    const derivative = syntheticAsset({ assetId: "synthetic-crop", lineage: { parentAssetId: "synthetic-asset", parentVersion: 1, changes: ["crop"], editorRef: "synthetic-editor", provenanceRef: "synthetic-edit-receipt" } });
    await expect(ingest({ ...derivative, deliverableId: "second-promised-original" }, "false-original")).rejects.toThrow("LINEAGE_OWNERSHIP_MISMATCH");
    await ingest(derivative, "crop");
    fixtures.state.rights.set("synthetic-asset", { allowedChanges: [] });
    expect((await repository.eligibility(use("synthetic-crop"))).reasonCodes).toContain("DERIVATIVE_OUTSIDE_RIGHTS_SCOPE");
    fixtures.state.rights.set("synthetic-asset", { channels: ["tiktok"] });
    expect((await repository.eligibility(use("synthetic-crop"))).reasonCodes).toContain("USE_OUTSIDE_RIGHTS_SCOPE");
  });
  it("detects an asset change while a rights lookup awaits, before persisting an export", async () => {
    await ingest();
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const authority: AssetAuthority = { ...fixtures.authority, currentRights: async (asset) => { entered(); await waiting; return syntheticRights(asset); } };
    const concurrent = new AssetRepository(db, assetTestScope, authority, clock);
    const pending = concurrent.prepareExport(use(), "racing-export");
    await started;
    await ingest(syntheticAsset({ hook: "Changed after lookup" }), "changed", 1);
    release();
    await expect(pending).rejects.toThrow("ASSET_USE_BLOCKED");
    expect(repository.exports("synthetic-asset")).toHaveLength(0);
  });
  it("serializes simultaneous ingest retries and rejects conflicting revisions", async () => {
    const receipts = await Promise.all([ingest(), ingest()]);
    expect(receipts[0]).toEqual(receipts[1]);
    const result = await Promise.allSettled([ingest(syntheticAsset({ hook: "A" }), "update-a", 1), ingest(syntheticAsset({ hook: "B" }), "update-b", 1)]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(repository.get("synthetic-asset")?.version).toBe(2);
  });
  it("records organic publication without ad rights; revocation proposes only verified reuse withdrawals", async () => {
    await ingest();
    const original = await repository.observeDeployment({ scope: assetTestScope, deployment: { assetId: "synthetic-asset", version: 1, exportId: null, receiptRef: { provider: "instagram", accountId: "synthetic-creator-account", sourceId: "synthetic-post-receipt" } } }, "organic-observe");
    const exp = await repository.prepareExport(use(), "prepare");
    const deployment = { assetId: "synthetic-asset", version: 1, exportId: exp.id, receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId: "synthetic-deployment-receipt" } };
    const ad = await repository.observeDeployment({ scope: assetTestScope, deployment }, "ad-observe");
    expect(await repository.observeDeployment({ scope: assetTestScope, deployment }, "duplicate-source-observe")).toEqual(ad);
    fixtures.state.rights.set("synthetic-asset", { status: "revoked", rightsVersion: "synthetic-revoked-v2" });
    const result = await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "revoke");
    expect(result.intents).toHaveLength(1);
    const intent = result.intents[0]!;
    expect(intent).toMatchObject({ deploymentId: ad.id, state: "proposed", owner: "paid_media" });
    expect(repository.deployments("synthetic-asset").find((d) => d.id === original.id)?.state).toBe("active");
    const receipt = (sourceId: string) => ({ scope: assetTestScope, receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId } });
    expect((await repository.reconcileWithdrawal(intent.id, receipt("uncertain"), "uncertain")).state).toBe("uncertain");
    fixtures.state.withdrawalOutcome = "withdrawn";
    fixtures.state.withdrawalSourceVersion = 2;
    expect((await repository.reconcileWithdrawal(intent.id, receipt("confirmed"), "confirmed")).state).toBe("confirmed");
    fixtures.state.withdrawalOutcome = "uncertain";
    fixtures.state.withdrawalSourceVersion = 3;
    expect((await repository.reconcileWithdrawal(intent.id, receipt("late-uncertain"), "late")).state).toBe("confirmed");
    expect(repository.withdrawals("synthetic-asset")[0]?.reconciliationReceipts).toHaveLength(3);
    expect((await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "repeat-reconcile")).intents).toHaveLength(1);
  });
  it("propagates a revoked ancestor to its deployed derivative", async () => {
    await ingest();
    await ingest(syntheticAsset({ assetId: "synthetic-crop", lineage: { parentAssetId: "synthetic-asset", parentVersion: 1, changes: ["crop"], editorRef: "synthetic-editor", provenanceRef: "synthetic-edit" } }), "crop");
    const exp = await repository.prepareExport(use("synthetic-crop"), "crop-export");
    await repository.observeDeployment({ scope: assetTestScope, deployment: { assetId: "synthetic-crop", version: 1, exportId: exp.id, receiptRef: { provider: "synthetic-ads", accountId: "synthetic-account", sourceId: "synthetic-crop-deployment" } } }, "crop-deployment");
    fixtures.state.rights.set("synthetic-asset", { status: "revoked" });
    const result = await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "ancestor-revoked");
    expect(result.intents[0]?.assetId).toBe("synthetic-crop");
    expect(result.impacts[0]?.eligibility.reasonCodes).toContain("RIGHTS_REVOKED");
  });
  it("orders withdrawal outcomes within native attempts and keeps every unresolved attempt uncertain", async () => {
    await ingest();
    const exp = await repository.prepareExport(use(), "withdrawal-order-export");
    await repository.observeDeployment({ scope: assetTestScope, deployment: { assetId: "synthetic-asset", version: 1, exportId: exp.id,
      receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId: "withdrawal-order-active" } } }, "withdrawal-order-active");
    fixtures.state.rights.set("synthetic-asset", { status: "revoked" });
    const intent = (await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "withdrawal-order-intent")).intents[0]!;
    let attemptId = "synthetic-attempt-a";
    let sourceVersion = 2;
    let observedAt = assetTestNow;
    const authority: AssetAuthority = { ...fixtures.authority, verifyWithdrawal: async (record, receiptRef, scope) => ({
      ...(await fixtures.authority.verifyWithdrawal(record, receiptRef, scope))!, attemptId, sourceVersion, observedAt,
    }) };
    repository = new AssetRepository(db, assetTestScope, authority, clock);
    const receipt = (sourceId: string) => ({ scope: assetTestScope, receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId } });
    const record = (sourceId: string) => repository.reconcileWithdrawal(intent.id, receipt(sourceId), sourceId);
    const uncertain = await record("newer-uncertain");
    expect(uncertain.state).toBe("uncertain");
    expect(await record("newer-uncertain")).toEqual(uncertain);
    fixtures.state.withdrawalOutcome = "not_applied"; sourceVersion = 1; observedAt = "2026-11-04T11:59:00.000Z";
    const late = await record("older-unseen-not-applied");
    expect(late.state).toBe("uncertain");
    expect(late.reconciliationReceipts).toHaveLength(2);
    // A different retry attempt cannot resolve the first attempt's uncertain outcome.
    attemptId = "synthetic-attempt-b"; observedAt = assetTestNow;
    expect((await record("other-attempt-not-applied")).state).toBe("uncertain");
    attemptId = "synthetic-attempt-a"; sourceVersion = 3;
    expect((await record("same-attempt-conclusively-not-applied")).state).toBe("proposed");
    // A later retry on the same deployment generation is tracked independently.
    attemptId = "synthetic-attempt-c"; sourceVersion = 1; fixtures.state.withdrawalOutcome = "uncertain";
    expect((await record("retry-uncertain")).state).toBe("uncertain");
    sourceVersion = 2; fixtures.state.withdrawalOutcome = "withdrawn";
    const confirmed = await record("retry-confirmed");
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.reconciliationReceipts).toHaveLength(6);
    fixtures.state.withdrawalOutcome = "not_applied";
    await expect(record("conflicting-same-native-version")).rejects.toThrow("WITHDRAWAL_SOURCE_VERSION_CONFLICT");
    await expect(repository.reconcileWithdrawal(intent.id, { ...receipt("forged-order"), attemptId: "caller-attempt", sourceVersion: 99 }, "forged-order")).rejects.toThrow();
    const reopened = new AssetRepository(db, assetTestScope, authority, clock);
    expect(reopened.withdrawals("synthetic-asset")[0]).toEqual(confirmed);
  });
  it("records an exact known removal when a deleted destination is unavailable without trusting a new use", async () => {
    await ingest();
    const exp = await repository.prepareExport(use(), "removal-export");
    const otherExport = await repository.prepareExport(use(), "different-use-export");
    const receipt = (sourceId: string, exportId = exp.id) => ({ scope: assetTestScope, deployment: { assetId: "synthetic-asset", version: 1, exportId,
      receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId } } });
    const active = await repository.observeDeployment(receipt("known-active"), "known-active");
    const authority: AssetAuthority = { ...fixtures.authority, resolveDestination: async () => null,
      verifyDeployment: async (request, scope) => ({ ...(await fixtures.authority.verifyDeployment(request, scope))!, state: "removed", sourceVersion: 2 }),
    };
    repository = new AssetRepository(db, assetTestScope, authority, clock);
    await expect(repository.observeDeployment(receipt("unbound-export-removal", otherExport.id), "unbound-export-removal")).rejects.toThrow("DEPLOYMENT_DESTINATION_UNVERIFIED");
    const wrongScope: AssetAuthority = { ...authority, verifyDeployment: async (request, scope) => ({
      ...(await authority.verifyDeployment(request, scope))!, scope: { ...scope, accountId: "synthetic-other-account" },
    }) };
    await expect(new AssetRepository(db, assetTestScope, wrongScope, clock).observeDeployment(receipt("cross-scope-removal"), "cross-scope-removal")).rejects.toThrow("DEPLOYMENT_BINDING_MISMATCH");
    const wrongDestination: AssetAuthority = { ...authority, verifyDeployment: async (request, scope) => ({
      ...(await authority.verifyDeployment(request, scope))!, destination: { ...syntheticUse().destination, sourceId: "synthetic-other-placement" },
    }) };
    await expect(new AssetRepository(db, assetTestScope, wrongDestination, clock).observeDeployment(receipt("wrong-destination-removal"), "wrong-destination-removal")).rejects.toThrow("EXPORT_DESTINATION_MISMATCH");
    const removed = await repository.observeDeployment(receipt("confirmed-known-removal"), "confirmed-known-removal");
    expect(removed).toMatchObject({ id: active.id, state: "removed", sourceVersion: 2 });
    expect(repository.deployments("synthetic-asset")).toEqual([removed]);
    expect(repository.deploymentObservations("synthetic-asset")).toEqual([active, removed]);
    expect((await repository.eligibility(use())).reasonCodes).toContain("DESTINATION_AUTHORITY_UNAVAILABLE");
    await expect(repository.prepareExport(use(), "reuse-still-blocked")).rejects.toThrow("ASSET_USE_BLOCKED");
  });
  it("keeps append-only receipts for one deployment and does not regress a newer removal", async () => {
    await ingest();
    const exp = await repository.prepareExport(use(), "prepare-observed-ad");
    let state: "active" | "removed" = "active"; let sourceVersion = 1;
    const authority: AssetAuthority = { ...fixtures.authority, verifyDeployment: async (request, scope) => ({ ...(await fixtures.authority.verifyDeployment(request, scope))!, state, sourceVersion }) };
    repository = new AssetRepository(db, assetTestScope, authority, clock);
    const observe = (receiptId: string) => repository.observeDeployment({ scope: assetTestScope, deployment: { assetId: "synthetic-asset", version: 1, exportId: exp.id,
      receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId: receiptId } } }, receiptId);
    const first = await observe("first-active");
    const repeated = await observe("second-active");
    expect(repeated.id).toBe(first.id);
    expect(repository.deployments("synthetic-asset")).toHaveLength(1);
    expect(repository.deploymentObservations("synthetic-asset")).toHaveLength(2);
    fixtures.state.rights.set("synthetic-asset", { status: "revoked" });
    expect((await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "dedup-revoke")).intents).toHaveLength(1);
    state = "removed"; sourceVersion = 2;
    expect((await observe("newer-removed")).id).toBe(first.id);
    state = "active"; sourceVersion = 1;
    await observe("late-active");
    const reopened = new AssetRepository(db, assetTestScope, authority, clock);
    expect(reopened.deployments("synthetic-asset")).toMatchObject([{ id: first.id, state: "removed", sourceVersion: 2 }]);
    expect(reopened.deploymentObservations("synthetic-asset")).toHaveLength(4);
    expect((await reopened.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "removed-revoke")).intents).toEqual([]);
    sourceVersion = 2;
    await expect(observe("conflicting-version")).rejects.toThrow("DEPLOYMENT_SOURCE_VERSION_CONFLICT");
    expect(reopened.deploymentObservations("synthetic-asset")).toHaveLength(4);
    const firstIntent = reopened.withdrawals("synthetic-asset")[0]!;
    fixtures.state.withdrawalOutcome = "withdrawn";
    await reopened.reconcileWithdrawal(firstIntent.id, { scope: assetTestScope, receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId: "confirmed-first-generation" } }, "confirm-first-generation");
    // A genuine later reactivation requires a new intent; the old confirmation stays historical.
    sourceVersion = 3;
    await observe("genuine-reactivation");
    const reactivated = await reopened.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset" }, "reactivation-revoke");
    expect(reactivated.intents).toHaveLength(1);
    expect(reactivated.intents[0]).toMatchObject({ state: "proposed", deploymentSourceVersion: 3, deploymentId: first.id });
    expect(reactivated.intents[0]!.id).not.toBe(firstIntent.id);
    expect(reopened.withdrawals("synthetic-asset")).toHaveLength(2);
    expect(reopened.withdrawals("synthetic-asset").find((intent) => intent.id === firstIntent.id)?.state).toBe("confirmed");
    const wrongGeneration: AssetAuthority = { ...authority, verifyWithdrawal: async (intent, receiptRef, scope) => ({ ...(await authority.verifyWithdrawal(intent, receiptRef, scope))!, deploymentSourceVersion: 1 }) };
    await expect(new AssetRepository(db, assetTestScope, wrongGeneration, clock).reconcileWithdrawal(reactivated.intents[0]!.id, { scope: assetTestScope, receiptRef: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId: "old-generation-receipt" } }, "wrong-generation")).rejects.toThrow("WITHDRAWAL_BINDING_MISMATCH");
  });
  it("requires a fresh trusted placement binding instead of accepting caller channel labels", async () => {
    await ingest();
    const exp = await repository.prepareExport(use(), "known-placement");
    const mislabeled = { ...use(), use: { ...syntheticUse(), channel: "tiktok" } };
    expect((await repository.eligibility(mislabeled)).reasonCodes).toContain("DESTINATION_SCOPE_MISMATCH");
    await expect(repository.prepareExport(mislabeled, "mislabeled-placement")).rejects.toThrow("ASSET_USE_BLOCKED");
    const authority: AssetAuthority = { ...fixtures.authority, resolveDestination: async () => null };
    const unavailable = new AssetRepository(db, assetTestScope, authority, clock);
    expect((await unavailable.eligibility(use())).reasonCodes).toContain("DESTINATION_AUTHORITY_UNAVAILABLE");
    await expect(unavailable.observeDeployment({ scope: assetTestScope, deployment: { assetId: "synthetic-asset", version: 1, exportId: exp.id, receiptRef: syntheticUse().destination } }, "unverified-placement")).rejects.toThrow("DEPLOYMENT_DESTINATION_UNVERIFIED");
    const staleAuthority: AssetAuthority = { ...fixtures.authority, resolveDestination: async (u, scope) => ({ ...(await fixtures.authority.resolveDestination(u, scope))!, validUntil: assetTestNow }) };
    expect((await new AssetRepository(db, assetTestScope, staleAuthority, clock).eligibility(use())).reasonCodes).toContain("DESTINATION_OBSERVATION_STALE");
  });
  it("checks rights expiry after a delayed destination lookup", async () => {
    await ingest();
    let currentTime = assetTestNow;
    const authority: AssetAuthority = { ...fixtures.authority, resolveDestination: async (u, scope) => {
      const result = await fixtures.authority.resolveDestination(u, scope);
      currentTime = "2026-11-04T13:00:00.000Z";
      return { ...result!, validUntil: "2026-11-04T14:00:00.000Z" };
    } };
    const delayed = new AssetRepository(db, assetTestScope, authority, () => currentTime);
    expect((await delayed.eligibility(use())).reasonCodes).toContain("RIGHTS_OBSERVATION_STALE");
  });
  it("searches metadata/current J09 fields without claiming a partial scan is complete", async () => {
    for (let i = 0; i < 3; i++) await ingest(syntheticAsset({ assetId: `synthetic-asset-${i}`, campaignId: `synthetic-campaign-${i}` }), `asset-${i}`);
    fixtures.state.rights.set("synthetic-asset-0", { status: "revoked" });
    expect(repository.list({ query: "desk", campaignId: "synthetic-campaign-1" }).total).toBe(1);
    const page = await repository.search({ rightsState: "granted", limit: 1 });
    expect(page).toMatchObject({ records: [], candidateTotal: 3, scanned: 1, nextOffset: 1, coverage: "partial" });
    const all = await repository.search({ review: "accepted" });
    expect(all.records).toHaveLength(3);
  });
  it("never writes an unverified deployment or withdrawal receipt", async () => {
    await ingest();
    const unavailable = new AssetRepository(db, assetTestScope);
    await expect(unavailable.observeDeployment({ scope: assetTestScope, deployment: { assetId: "synthetic-asset", version: 1, exportId: null, receiptRef: syntheticUse().destination } }, "fake")).rejects.toThrow("DEPLOYMENT_AUTHORITY_UNAVAILABLE");
    expect(repository.deployments("synthetic-asset")).toHaveLength(0);
  });
  it("resumes bounded rights scans through empty pages with a frozen append-only watermark", async () => {
    await ingest(syntheticAsset({ assetId: "synthetic-other" }), "other");
    await ingest();
    await repository.prepareExport(use("synthetic-other"), "unrelated-export");
    const target = await repository.prepareExport(use(), "target-export");
    fixtures.state.rights.set("synthetic-asset", { status: "revoked" });
    const first = await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset", limit: 1 }, "scan-1");
    expect(first).toMatchObject({ impacts: [], intents: [], scanned: 1, scanFinished: false, snapshotMaxRow: 2 });
    expect(first.nextCursor).not.toBeNull();
    expect(await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset", limit: 1 }, "scan-1")).toEqual(first);
    // New unrelated exports do not move this scan's high-water mark while it is in progress.
    await repository.prepareExport(use("synthetic-other"), "new-export-after-start");
    const second = await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset", cursor: first.nextCursor, limit: 1 }, "scan-2");
    expect(second).toMatchObject({ scanned: 1, scanFinished: true, snapshotMaxRow: 2, nextCursor: null });
    expect(second.impacts.map((impact) => impact.exportId)).toEqual([target.id]);
    await expect(repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-other", cursor: first.nextCursor }, "cross-asset-cursor")).rejects.toThrow("INVALID_RECONCILIATION_CURSOR");
    await expect(repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset", cursor: "forged-cursor" }, "forged")).rejects.toThrow("INVALID_RECONCILIATION_CURSOR");
  });
  it("does not abort a small asset's rights scan when the registry exceeds 1000 exports", async () => {
    await ingest();
    const template = await repository.prepareExport(use(), "template-export");
    // Bulk fixture records exercise the scan boundary without pretending they are provider deliveries.
    for (let index = 0; index < 1001; index++) {
      const exp = { ...template, id: `synthetic-prepared-${index}` };
      db.prepare("INSERT INTO creator_asset_exports VALUES(?,?,?)").run(exp.id, exp.assetId, JSON.stringify(exp));
    }
    fixtures.state.rights.set("synthetic-asset", { status: "revoked" });
    const result = await repository.reconcileRights({ scope: assetTestScope, assetId: "synthetic-asset", limit: 100 }, "large-registry");
    expect(result.scanned).toBe(100);
    expect(result.impacts).toHaveLength(100);
    expect(result.scanFinished).toBe(false);
    expect(result.intents).toEqual([]);
  });
});
