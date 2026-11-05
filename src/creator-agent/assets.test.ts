// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assetSubmissionSchema, evaluateAssetUse } from "./assets.ts";
import { digest } from "./config.ts";
import { assetTestNow, assetTestScope, syntheticAsset, syntheticChecksum, syntheticRights, syntheticUse } from "./assetTestFixtures.ts";
import type { AssetRights, StoredAsset } from "./assets.ts";

const record = (): StoredAsset => ({ submission: syntheticAsset(), version: 1, recordedAt: assetTestNow,
  submissionHash: digest(syntheticAsset()), storageIdentity: "synthetic-storage",
  sourceEvidence: { scope: assetTestScope, submissionHash: digest(syntheticAsset()), observedAt: assetTestNow, authorizationRef: "synthetic-source", availability: "available", checksum: syntheticChecksum } });

describe("asset rights are exact-version scoped J09 observations", () => {
  it("rejects URL/path source references and unknown client permission fields", () => {
    const asset = syntheticAsset();
    expect(assetSubmissionSchema.safeParse({ ...asset, source: { ...asset.source, sourceId: "https://example.test/private?token=secret" } }).success).toBe(false);
    expect(assetSubmissionSchema.safeParse({ ...asset, source: { ...asset.source, sourceId: "../../file" } }).success).toBe(false);
    expect(assetSubmissionSchema.safeParse({ ...asset, rightsGranted: true }).success).toBe(false);
  });
  it("accepts exact permission without conferring account publication permission", () => {
    const asset = record();
    expect(evaluateAssetUse(asset, syntheticUse(), assetTestScope, [{ asset, rights: syntheticRights(asset) }], assetTestNow)).toMatchObject({ state: "eligible", publishingAuthorized: false });
  });
  it.each([
    [{ status: "revoked" }, "RIGHTS_REVOKED"],
    [{ acceptedVersion: 2 }, "EXACT_VERSION_NOT_ACCEPTED"],
    [{ endsAt: assetTestNow }, "RIGHTS_OUTSIDE_TERM"],
    [{ validUntil: assetTestNow }, "RIGHTS_OBSERVATION_STALE"],
    [{ channels: ["tiktok"] }, "USE_OUTSIDE_RIGHTS_SCOPE"],
    [{ musicCleared: null }, "THIRD_PARTY_RIGHTS_PENDING"],
    [{ checksum: "b".repeat(64) }, "RIGHTS_BINDING_MISMATCH"],
    [{ productRevision: "revision-b" }, "PRODUCT_REVISION_MISMATCH"],
  ] as [Partial<AssetRights>, string][])("blocks changed or incomplete authority %j", (override, reason) => {
    const asset = record();
    const rights = syntheticRights(asset, override);
    expect(evaluateAssetUse(asset, syntheticUse(), assetTestScope, [{ asset, rights }], assetTestNow).reasonCodes).toContain(reason);
  });
  it("does not inherit a parent's permission to make an unlicensed derivative", () => {
    const parent = record();
    const submission = syntheticAsset({ assetId: "synthetic-crop", lineage: { parentAssetId: parent.submission.assetId, parentVersion: 1, changes: ["crop"], editorRef: "synthetic-editor", provenanceRef: "synthetic-edit" } });
    const child = { ...record(), submission, submissionHash: digest(submission) };
    const result = evaluateAssetUse(child, syntheticUse(submission.assetId), assetTestScope, [{ asset: child, rights: syntheticRights(child) }, { asset: parent, rights: syntheticRights(parent, { allowedChanges: [] }) }], assetTestNow);
    expect(result.reasonCodes).toContain("DERIVATIVE_OUTSIDE_RIGHTS_SCOPE");
  });
});
