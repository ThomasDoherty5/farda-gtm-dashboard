// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import type { AssetRights, StoredAsset } from "../assets.ts";
import { assetTestNow, assetTestScope, syntheticAsset, syntheticChecksum, syntheticRights, syntheticUse } from "../assetTestFixtures.ts";
import { evaluatePaidReuse, type RightsGateInput } from "./rightsGate.ts";

const record = (): StoredAsset => ({ submission: syntheticAsset(), version: 1, recordedAt: assetTestNow, submissionHash: digest(syntheticAsset()), storageIdentity: "synthetic-storage",
  sourceEvidence: { scope: assetTestScope, submissionHash: digest(syntheticAsset()), observedAt: assetTestNow, authorizationRef: "synthetic-source", availability: "available", checksum: syntheticChecksum } });
function gateInput(rights: Partial<AssetRights> | null): RightsGateInput {
  const asset = record();
  return { scope: assetTestScope, asset, use: syntheticUse(), chain: [{ asset, rights: rights === null ? null : syntheticRights(asset, { validUntil: "2026-12-31T00:00:00.000Z", ...rights }) }] };
}
const now = Date.parse(assetTestNow);

describe("paid reuse rights gate", () => {
  it("allows paid reuse only with current granted rights and confers no publishing authority", () => {
    expect(evaluatePaidReuse(gateInput({}), now, 14)).toMatchObject({ paidReuse: "allowed", rightsStatus: "granted", publishingAuthorized: false,
      expiry: { endsAt: "2026-12-01T00:00:00.000Z", state: "current", daysRemaining: 27 }, warningKey: null });
  });
  it.each([
    [null, "missing", "J09_RIGHTS_UNAVAILABLE"],
    [{ status: "expired" as const }, "expired", "RIGHTS_EXPIRED"],
    [{ endsAt: "2026-11-04T00:00:00.000Z" }, "expired", "RIGHTS_OUTSIDE_TERM"],
    [{ status: "unknown" as const }, "unknown", "RIGHTS_UNKNOWN"],
    [{ validUntil: assetTestNow }, "unknown", "RIGHTS_OBSERVATION_STALE"],
    [{ status: "revoked" as const }, "revoked", "RIGHTS_REVOKED"],
    [{ status: "pending" as const }, "pending", "RIGHTS_PENDING"],
  ])("blocks paid reuse when rights are %j", (rights, status, reason) => {
    const result = evaluatePaidReuse(gateInput(rights), now, 14);
    expect(result).toMatchObject({ paidReuse: "blocked", rightsStatus: status });
    expect(result.reasonCodes).toEqual(expect.arrayContaining([reason, `PAID_REUSE_RIGHTS_${status.toUpperCase()}`]));
  });
  it("blocks granted rights for another content version, as the asset store does", () => {
    expect(evaluatePaidReuse(gateInput({ acceptedVersion: 2 }), now, 14).reasonCodes).toContain("EXACT_VERSION_NOT_ACCEPTED");
  });
  it("warns ahead of expiry with a stable key while reuse is still allowed", () => {
    const later = Date.parse("2026-11-20T12:00:00.000Z");
    const first = evaluatePaidReuse(gateInput({}), later, 14), again = evaluatePaidReuse(gateInput({}), later + 86_400_000, 14);
    expect(first).toMatchObject({ paidReuse: "allowed", expiry: { state: "warning", daysRemaining: 11 } });
    expect(first.warningKey).toMatch(/^rights1-[a-f0-9]{40}$/);
    expect(again.warningKey).toBe(first.warningKey);
    expect(evaluatePaidReuse(gateInput({ rightsVersion: "synthetic-rights-v2" }), later, 14).warningKey).not.toBe(first.warningKey);
  });
  it("only gates paid reuse", () => {
    const input = gateInput({});
    expect(() => evaluatePaidReuse({ ...input, use: { ...input.use, kind: "brand_organic" } }, now, 14)).toThrow("PAID_REUSE_ONLY");
  });
});
