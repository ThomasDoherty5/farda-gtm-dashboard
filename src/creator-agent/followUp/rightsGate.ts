import { digest } from "../config.ts";
import { evaluateAssetUse, sameAssetScope, type AssetRights, type AssetScope, type AssetUse, type StoredAsset } from "../assets.ts";

const DAY_MS = 86_400_000;
export type RightsStatus = "granted" | "missing" | "unknown" | "pending" | "expired" | "revoked";
export type RightsGateInput = {
  scope: AssetScope;
  asset: StoredAsset;
  /** The asset first, then each ancestor, as `evaluateAssetUse` expects. */
  chain: { asset: StoredAsset; rights: AssetRights | null }[];
  use: AssetUse;
};
export type RightsGateResult = {
  paidReuse: "allowed" | "blocked";
  rightsStatus: RightsStatus;
  reasonCodes: string[];
  expiry: { endsAt: string | null; state: "current" | "warning" | "expired" | "unknown"; daysRemaining: number | null };
  /** Stable binding for one expiry warning: asset version, rights version and end date. */
  warningKey: string | null;
  publishingAuthorized: false;
};

/** The asset's own J09 status, read with the same binding and freshness rules as the asset store. */
function statusOf(input: RightsGateInput, now: number): RightsStatus {
  const own = input.chain[0];
  const r = own?.rights;
  if (!own || !r) return "missing";
  const a = own.asset;
  const bound = sameAssetScope(r.scope, input.scope) && r.assetId === a.submission.assetId &&
    r.assetVersion === a.version && r.submissionHash === a.submissionHash && r.checksum === a.sourceEvidence.checksum;
  if (!bound || Date.parse(r.observedAt) > now || Date.parse(r.validUntil) <= now) return "unknown";
  if (r.status === "granted" && r.endsAt && Date.parse(r.endsAt) <= now) return "expired";
  return r.status === "granted" ? "granted" : r.status;
}

/**
 * Paid reuse gate over J09 rights. Delegates eligibility to `evaluateAssetUse`, so missing, expired, revoked
 * or unknown rights block reuse exactly as the asset store does. Adds an expiry warning window.
 */
export function evaluatePaidReuse(input: RightsGateInput, now: number, warningDays: number): RightsGateResult {
  if (input.use.kind !== "paid_ad") throw new Error("PAID_REUSE_ONLY");
  if (!Number.isFinite(now)) throw new Error("INVALID_CLOCK");
  const eligibility = evaluateAssetUse(input.asset, input.use, input.scope, input.chain, new Date(now).toISOString());
  const rightsStatus = statusOf(input, now);
  const reasons = [...eligibility.reasonCodes];
  if (rightsStatus !== "granted") reasons.push(`PAID_REUSE_RIGHTS_${rightsStatus.toUpperCase()}`);
  const r = input.chain[0]?.rights ?? null;
  const endsAt = rightsStatus === "granted" || rightsStatus === "expired" ? r?.endsAt ?? null : null;
  let expiry: RightsGateResult["expiry"] = { endsAt, state: "unknown", daysRemaining: null };
  let warningKey: string | null = null;
  if (endsAt) {
    const remaining = Date.parse(endsAt) - now, daysRemaining = Math.max(0, Math.ceil(remaining / DAY_MS));
    const state = remaining <= 0 ? "expired" : remaining <= warningDays * DAY_MS ? "warning" : "current";
    expiry = { endsAt, state, daysRemaining };
    if (state === "warning" && r) warningKey = "rights1-" + digest([r.assetId, r.assetVersion, r.rightsVersion, endsAt]).slice(0, 40);
  }
  const blocked = eligibility.state !== "eligible" || rightsStatus !== "granted";
  return { paidReuse: blocked ? "blocked" : "allowed", rightsStatus, reasonCodes: [...new Set(reasons)], expiry, warningKey, publishingAuthorized: false };
}
