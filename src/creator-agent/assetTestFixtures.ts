// Fictional server-authority fixtures. Never used by the production service or browser adapter.
import { createRequire } from "node:module";
import { digest } from "./config.ts";
import type { AssetAuthority, AssetRights, AssetScope, AssetSubmission, AssetUse, StoredAsset, WithdrawalEvidence } from "./assets.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const assetTestScope: AssetScope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account" };
export const assetTestNow = "2026-11-04T12:00:00.000Z";
export const syntheticChecksum = "a".repeat(64);
export function assetTestDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS agent_scope (id INTEGER PRIMARY KEY, workspace_id TEXT, account_id TEXT)");
  db.prepare("INSERT OR IGNORE INTO agent_scope VALUES(1,?,?)").run(assetTestScope.workspaceId, assetTestScope.accountId);
  return db;
}
export function syntheticAsset(overrides: Partial<AssetSubmission> = {}): AssetSubmission {
  return {
    assetId: "synthetic-asset", fileVersion: "file-v1", creatorId: "synthetic-creator", collaborationId: "synthetic-collaboration",
    deliverableId: "synthetic-original-1", submissionId: "synthetic-submission", briefId: "synthetic-brief", briefVersion: "brief-v1",
    campaignId: "synthetic-campaign", productId: "synthetic-product", productRevision: "revision-a",
    useCase: "Fictional product demonstration", concept: "Desk routine", hook: "A daily routine",
    format: "video/mp4", durationMs: 30_000,
    source: { provider: "synthetic-files", accountId: assetTestScope.accountId, sourceId: "synthetic-object" }, lineage: null, ...overrides,
  };
}
export function syntheticUse(assetId = "synthetic-asset", version = 1): AssetUse {
  return { assetId, version, kind: "paid_ad", channel: "instagram", territory: "US", productId: "synthetic-product", productRevision: "revision-a",
    destination: { provider: "synthetic-ads", accountId: "synthetic-ad-account", sourceId: "synthetic-creative" } };
}
export function syntheticRights(asset: StoredAsset, overrides: Partial<AssetRights> = {}): AssetRights {
  return { scope: assetTestScope, assetId: asset.submission.assetId, assetVersion: asset.version, submissionHash: asset.submissionHash,
    checksum: asset.sourceEvidence.checksum, review: "accepted", acceptedVersion: asset.version,
    approvalVersion: "synthetic-approval-v1", rightsVersion: "synthetic-rights-v1", evidenceRef: "synthetic-j09-receipt",
    status: "granted", startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z",
    observedAt: assetTestNow, validUntil: "2026-11-04T13:00:00.000Z", kinds: ["paid_ad", "brand_organic", "owned_channel"], channels: ["instagram", "tiktok", "website"], territories: ["US"],
    allowedChanges: ["crop", "subtitles", "cut", "audio", "format"], musicCleared: true, thirdPartyCleared: true,
    productId: asset.submission.productId, productRevision: asset.submission.productRevision, ...overrides };
}
export function syntheticAssetAuthority() {
  const state: {
    availability: "available" | "unavailable" | "quarantined"; checksum: string;
    rights: Map<string, Partial<AssetRights> | null>; withdrawalOutcome: WithdrawalEvidence["outcome"];
  } = { availability: "available", checksum: syntheticChecksum, rights: new Map(), withdrawalOutcome: "uncertain" };
  const authority: AssetAuthority = {
    resolveSource: async (submission, scope) => ({ scope, submissionHash: digest(submission), authorizationRef: "synthetic-source-receipt", observedAt: assetTestNow, availability: state.availability, checksum: state.checksum }),
    currentRights: async (asset) => state.rights.get(asset.submission.assetId) === null ? null : syntheticRights(asset, state.rights.get(asset.submission.assetId) ?? {}),
    resolveDestination: async (use, scope) => ({ scope, destination: use.destination, kind: "paid_ad", channel: "instagram", territory: "US", authorizationRef: "synthetic-destination-receipt", observedAt: assetTestNow, validUntil: "2026-11-04T13:00:00.000Z" }),
    verifyDeployment: async (request, scope) => ({ scope, assetId: request.assetId, assetVersion: request.version, exportId: request.exportId,
      receiptRef: request.receiptRef, destination: request.exportId ? syntheticUse().destination : { provider: "instagram", accountId: "synthetic-creator-account", sourceId: "synthetic-post" },
      observedAt: assetTestNow, sourceVersion: 1, kind: request.exportId ? "reuse" : "creator_publication", state: "active" }),
    verifyWithdrawal: async (intent, receiptRef, scope) => ({ scope, intentId: intent.id, deploymentId: intent.deploymentId, deploymentSourceVersion: intent.deploymentSourceVersion, receiptRef, observedAt: assetTestNow, outcome: state.withdrawalOutcome }),
  };
  return { state, authority };
}
