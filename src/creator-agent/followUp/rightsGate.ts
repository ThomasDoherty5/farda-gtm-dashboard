import { digest } from "../config.ts";
import { evaluateAssetUse, sameAssetScope, type AssetRights, type AssetScope, type AssetUse, type StoredAsset } from "../assets.ts";

const DAY_MS = 86_400_000;
const DEFINITE: RightsStatus[] = ["revoked", "expired", "missing"];
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

/** One chain entry's J09 status, read with the same binding and freshness rules as the asset store. */
function statusOf(entry: RightsGateInput["chain"][number], scope: AssetScope, now: number): RightsStatus {
  const r = entry.rights, a = entry.asset;
  if (!r) return "missing";
  const bound = sameAssetScope(r.scope, scope) && r.assetId === a.submission.assetId &&
    r.assetVersion === a.version && r.submissionHash === a.submissionHash && r.checksum === a.sourceEvidence.checksum;
  if (!bound || Date.parse(r.observedAt) > now || Date.parse(r.validUntil) <= now) return "unknown";
  if (r.status === "granted" && r.endsAt && Date.parse(r.endsAt) <= now) return "expired";
  return r.status === "granted" ? "granted" : r.status;
}

/**
 * Paid reuse gate over J09 rights. Delegates eligibility to `evaluateAssetUse`, so missing, expired, revoked
 * or unknown rights block reuse exactly as the asset store does. The status is the first definite unavailability
 * (revoked, expired, missing) along the chain, else the first other non-granted one; the expiry warning uses the
 * earliest end date anywhere in the chain.
 */
export function evaluatePaidReuse(input: RightsGateInput, now: number, warningDays: number): RightsGateResult {
  if (input.use.kind !== "paid_ad") throw new Error("PAID_REUSE_ONLY");
  if (!Number.isFinite(now)) throw new Error("INVALID_CLOCK");
  const eligibility = evaluateAssetUse(input.asset, input.use, input.scope, input.chain, new Date(now).toISOString());
  const statuses = input.chain.map(entry => statusOf(entry, input.scope, now));
  // A definite unavailability anywhere in the chain outranks an unknown or pending link.
  const rightsStatus: RightsStatus = statuses.length === 0 ? "missing"
    : statuses.find(s => DEFINITE.includes(s)) ?? statuses.find(s => s !== "granted") ?? "granted";
  const reasons = [...eligibility.reasonCodes];
  if (rightsStatus !== "granted") reasons.push(`PAID_REUSE_RIGHTS_${rightsStatus.toUpperCase()}`);
  const dated = input.chain.flatMap((entry, i) => (statuses[i] === "granted" || statuses[i] === "expired") && entry.rights?.endsAt
    ? [{ rights: entry.rights, endsAt: entry.rights.endsAt }] : []).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  const earliest = dated[0];
  let expiry: RightsGateResult["expiry"] = { endsAt: null, state: "unknown", daysRemaining: null };
  let warningKey: string | null = null;
  if (earliest) {
    const remaining = Date.parse(earliest.endsAt) - now, daysRemaining = Math.max(0, Math.ceil(remaining / DAY_MS));
    const state = remaining <= 0 ? "expired" : remaining <= warningDays * DAY_MS ? "warning" : "current";
    expiry = { endsAt: earliest.endsAt, state, daysRemaining };
    const r = earliest.rights;
    if (state === "warning") warningKey = "rights1-" + digest([r.assetId, r.assetVersion, r.rightsVersion, earliest.endsAt]).slice(0, 40);
  }
  const blocked = eligibility.state !== "eligible" || rightsStatus !== "granted";
  return { paidReuse: blocked ? "blocked" : "allowed", rightsStatus, reasonCodes: [...new Set(reasons)], expiry, warningKey, publishingAuthorized: false };
}
