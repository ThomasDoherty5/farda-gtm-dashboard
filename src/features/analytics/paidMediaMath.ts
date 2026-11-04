import type { PaidMediaData, RightsState } from "@/fixtures/analytics";

const money = (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(v);
export const dollars = money;

/** Whole thousands read as "800k"; anything else keeps its exact figure. */
export const compact = (n: number) => (n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : new Intl.NumberFormat("en-US").format(n));

/** Percent to two places, from a part and a whole. A zero whole is N/A, never 0%. */
export const pctText = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(2)}%` : "N/A");

/** CTR, CPM, CPC and platform ROAS from the channel's own counts. A zero denominator shows N/A. */
export function channelRates(c: PaidMediaData["channels"][number]) {
  const spend = c.spend.minorUnits / 100;
  return {
    ctr: pctText(c.clicks, c.impressions),
    cpm: c.impressions > 0 ? money((spend / c.impressions) * 1000) : "N/A",
    cpc: c.clicks > 0 ? money(spend / c.clicks) : "N/A",
    roas: spend > 0 ? `${(c.platformPurchaseValue.minorUnits / c.spend.minorUnits).toFixed(2)}×` : "N/A",
  };
}

export function rightsLabel(a: { rights: RightsState; expiresInDays: number | null }) {
  switch (a.rights) {
    case "cleared": return "Cleared";
    case "expiring": return a.expiresInDays === null ? "Expiring" : `Expires in ${a.expiresInDays}d`;
    case "notGranted": return "Not granted";
    case "unknown": return "Unknown";
  }
}
