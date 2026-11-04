/**
 * Headline acquisition metrics for the demo adapter. Live values come from the THO-283 adapter; these derivations exist so
 * the fixtures can be hand-checked. Unknown (null), zero and provisional are three different states and never collapse to 0.
 */
export type NaReason = "UNKNOWN_INPUT" | "ZERO_DENOMINATOR" | "INVALID_INPUT";
export type MetricResult =
  | { state: "known" | "provisional"; value: number; reasonCode: string | null }
  | { state: "notApplicable"; value: null; reasonCode: NaReason };

/** Reasons that make a computed value provisional rather than final. */
export type Caveat = "LANDED_COST_INCOMPLETE" | "RETENTION_IMMATURE" | "ACCOUNTING_MONTH_OPEN";

const na = (reasonCode: NaReason): MetricResult => ({ state: "notApplicable", value: null, reasonCode });

function divide(numerator: number | null, denominator: number | null, caveat?: Caveat | null): MetricResult {
  if (numerator === null || denominator === null) return na("UNKNOWN_INPUT");
  // A NaN, an infinity or a negative amount or count is a bad input, not a measurement: it is never shown as a value.
  const bad = (n: number) => !Number.isFinite(n) || n < 0;
  if (bad(numerator) || bad(denominator)) return na("INVALID_INPUT");
  if (denominator === 0) return na("ZERO_DENOMINATOR");
  const value = numerator / denominator;
  return caveat ? { state: "provisional", value, reasonCode: caveat } : { state: "known", value, reasonCode: null };
}

const roundMinor = (r: MetricResult): MetricResult => (r.value === null ? r : { ...r, value: Math.round(r.value) });

/** AOV = net receipts / valid orders. Result in minor units. */
export const aov = (netReceiptsMinor: number | null, validOrders: number | null, caveat?: Caveat | null) => roundMinor(divide(netReceiptsMinor, validOrders, caveat));

/** Blended CAC = included acquisition cost / new retained customers. Result in minor units; a known zero cost stays $0. */
export const blendedCac = (acquisitionCostMinor: number | null, newRetainedCustomers: number | null, caveat?: Caveat | null) => roundMinor(divide(acquisitionCostMinor, newRetainedCustomers, caveat));

/** MER = net receipts / total marketing spend in the same scope. A multiple, not a percentage. */
export const mer = (netReceiptsMinor: number | null, marketingSpendMinor: number | null, caveat?: Caveat | null) => divide(netReceiptsMinor, marketingSpendMinor, caveat);

/** Platform ROAS = that platform's reported purchase value / that platform's spend. Never summed across platforms. */
export const platformRoas = (platformPurchaseValueMinor: number | null, platformSpendMinor: number | null) => divide(platformPurchaseValueMinor, platformSpendMinor);

export type CostBasis = "paid" | "accrued" | "estimated";
export type CostBucket = { key: string; label: string; basis: CostBasis; minorUnits: number; /** True when the amount is also in cash paid, so it must not be added a second time. */ alsoInCash: boolean };

/** Acquisition cost: every bucket once, keyed. A repeated key is a double count and is reported, not silently summed. */
export function allocateCosts(buckets: readonly CostBucket[]) {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let total = 0;
  const byBasis: Record<CostBasis, number> = { paid: 0, accrued: 0, estimated: 0 };
  for (const b of buckets) {
    if (seen.has(b.key)) { duplicates.push(b.key); continue; }
    seen.add(b.key);
    total += b.minorUnits;
    byBasis[b.basis] += b.minorUnits;
  }
  return { totalMinor: total, byBasis, duplicates };
}

export const CAVEAT_TEXT: Record<Caveat, string> = {
  LANDED_COST_INCOMPLETE: "Provisional · landed cost incomplete",
  RETENTION_IMMATURE: "Provisional · retention window not yet mature",
  ACCOUNTING_MONTH_OPEN: "Provisional · accounting month open",
};
export const NA_TEXT: Record<NaReason, string> = { UNKNOWN_INPUT: "N/A · an input is unknown", ZERO_DENOMINATOR: "N/A · zero denominator", INVALID_INPUT: "N/A · an input is not a valid amount" };

const dollarsText = (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);

/** Display text for a result. N/A and provisional always say why. */
export function resultText(r: MetricResult, format: (v: number) => string): string {
  if (r.state === "notApplicable") return NA_TEXT[r.reasonCode];
  return r.state === "provisional" && r.reasonCode ? `${format(r.value)} · ${CAVEAT_TEXT[r.reasonCode as Caveat]}` : format(r.value);
}
export const moneyResult = (r: MetricResult) => resultText(r, dollarsText);
export const multipleResult = (r: MetricResult) => resultText(r, (v) => `${v.toFixed(2)}×`);

export type CaseInputs = { netReceiptsMinor: number | null; validOrders: number | null; acquisitionCostMinor: number | null; newRetainedCustomers: number | null; marketingSpendMinor: number | null; caveat: Caveat | null };

export type MetricName = "aov" | "cac" | "mer";
/** Which headline metrics each caveat makes provisional. Anything that depends on cost carries a cost caveat. */
export const CAVEAT_APPLIES: Record<Caveat, readonly MetricName[]> = {
  LANDED_COST_INCOMPLETE: ["cac", "mer"],
  RETENTION_IMMATURE: ["cac"],
  ACCOUNTING_MONTH_OPEN: ["aov", "cac", "mer"],
};
const caveatFor = (caveat: Caveat | null, metric: MetricName) => (caveat && CAVEAT_APPLIES[caveat].includes(metric) ? caveat : null);

/** The three computed headline metrics for one case, as display text. */
export function evaluateCase(i: CaseInputs) {
  return {
    aov: moneyResult(aov(i.netReceiptsMinor, i.validOrders, caveatFor(i.caveat, "aov"))),
    cac: moneyResult(blendedCac(i.acquisitionCostMinor, i.newRetainedCustomers, caveatFor(i.caveat, "cac"))),
    mer: multipleResult(mer(i.netReceiptsMinor, i.marketingSpendMinor, caveatFor(i.caveat, "mer"))),
  };
}
