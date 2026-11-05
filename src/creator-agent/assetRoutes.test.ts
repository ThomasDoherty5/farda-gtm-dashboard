// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetRepository } from "./assetStore.ts";
import { handleAssetRoute } from "./assetRoutes.ts";
import { assetTestDatabase, assetTestNow, assetTestScope, syntheticAsset, syntheticAssetAuthority, syntheticUse } from "./assetTestFixtures.ts";

describe("asset routes behind the authenticated service", () => {
  let db: ReturnType<typeof assetTestDatabase>; let repository: AssetRepository;
  beforeEach(() => { db = assetTestDatabase(); repository = new AssetRepository(db, assetTestScope, syntheticAssetAuthority().authority, () => assetTestNow); });
  afterEach(() => db.close());
  const body = () => ({ scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset() });
  const ingest = () => handleAssetRoute({ method: "POST", path: "/v1/assets/ingest", role: "reviewer", idempotencyKey: "synthetic-ingest", body: body() }, repository);
  it("leaves unrelated routes to the existing server and prevents reader mutations", async () => {
    expect(await handleAssetRoute({ method: "GET", path: "/v1/policy", role: "reader" }, repository)).toBeNull();
    expect(await handleAssetRoute({ method: "POST", path: "/v1/assets/ingest", role: "reader", body: body(), idempotencyKey: "reader-attempt" }, repository)).toMatchObject({ status: 403, body: { code: "REVIEWER_REQUIRED" } });
    expect(repository.list().total).toBe(0);
  });
  it("validates scope, strict payloads, opaque refs and idempotency before mutation", async () => {
    expect(await handleAssetRoute({ method: "POST", path: "/v1/assets/ingest", role: "reviewer", body: body() }, repository)).toMatchObject({ status: 400 });
    expect(await handleAssetRoute({ method: "POST", path: "/v1/assets/ingest", role: "reviewer", idempotencyKey: "other-scope", body: { ...body(), scope: { ...assetTestScope, workspaceId: "other" } } }, repository)).toMatchObject({ status: 403 });
    expect(await handleAssetRoute({ method: "POST", path: "/v1/assets/ingest", role: "reviewer", idempotencyKey: "extra", body: { ...body(), rightsGranted: true } }, repository)).toMatchObject({ status: 400 });
    expect(await handleAssetRoute({ method: "GET", path: "/v1/assets?limit=10000", role: "reader" }, repository)).toMatchObject({ status: 400 });
  });
  it("exposes persisted metadata and current eligibility without returning file URLs", async () => {
    expect(await ingest()).toMatchObject({ status: 200, body: { version: 1 } });
    expect(await handleAssetRoute({ method: "GET", path: "/v1/assets?query=desk&review=accepted", role: "reader" }, repository)).toMatchObject({ status: 200, body: { scanned: 1, coverage: "complete" } });
    const read = await handleAssetRoute({ method: "GET", path: "/v1/assets/synthetic-asset", role: "reader" }, repository);
    expect(read).toMatchObject({ status: 200, body: { asset: { version: 1 }, exports: [], deployments: [], withdrawals: [] } });
    expect(JSON.stringify(read)).not.toContain("https:");
    expect(await handleAssetRoute({ method: "POST", path: "/v1/assets/eligibility", role: "reader", body: { scope: assetTestScope, use: syntheticUse() } }, repository)).toMatchObject({ status: 200, body: { state: "eligible", publishingAuthorized: false } });
    expect(await handleAssetRoute({ method: "POST", path: "/v1/assets/exports", role: "reviewer", idempotencyKey: "prepare", body: { scope: assetTestScope, use: syntheticUse() } }, repository)).toMatchObject({ status: 200, body: { state: "prepared", externalEffect: "none" } });
  });
  it("returns a truthful pending boundary when source authority is unavailable", async () => {
    repository = new AssetRepository(db, assetTestScope);
    expect(await ingest()).toMatchObject({ status: 409, body: { code: "SOURCE_AUTHORITY_UNAVAILABLE", executionCertainty: "notApplied" } });
    expect(await handleAssetRoute({ method: "GET", path: "/v1/assets/missing", role: "reader" }, repository)).toMatchObject({ status: 404 });
  });
  it("does not expose private provider failures", async () => {
    const authority = syntheticAssetAuthority().authority;
    authority.resolveSource = async () => { throw new Error("private-file-location-and-token"); };
    repository = new AssetRepository(db, assetTestScope, authority);
    const response = await ingest();
    expect(response).toMatchObject({ status: 500, body: { code: "ASSET_OPERATION_FAILED" } });
    expect(JSON.stringify(response)).not.toContain("private-file-location");
  });
});
