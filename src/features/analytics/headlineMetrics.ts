/**
 * Headline acquisition metrics for the demo adapter. Live values come from the THO-283 adapter; these derivations exist so
 * the fixtures can be hand-checked. Unknown (null), zero and provisional are three different states and never collapse to 0.
 */
import { allocateCosts as reconcileEconomicCosts, sameReportingWindow, validReportingWindow, type CostScope } from "./economicCosts";
import type { AttributionData, MetricObservationScope } from "../../fixtures/analytics";

export type NaReason = "UNKNOWN_INPUT" | "ZERO_DENOMINATOR" | "INVALID_INPUT";
export type MetricResult =
  | { state: "known" | "provisional"; value: number; reasonCode: string | null }
  | { state: "notApplicable"; value: null; reasonCode: NaReason };

/** Reasons that make a computed value provisional rather than final. */
export type Caveat = "LANDED_COST_INCOMPLETE" | "RETENTION_IMMATURE" | "ACCOUNTING_MONTH_OPEN" | "ESTIMATED_COST";

const na = (reasonCode: NaReason): MetricResult => ({ state: "notApplicable", value: null, reasonCode });

function divide(numerator: number | null, denominator: number | null, caveat?: Caveat | null, signed = false): MetricResult {
  if (numerator === null || denominator === null) return na("UNKNOWN_INPUT");
  // A NaN, an infinity or a negative amount or count is a bad input, not a measurement: it is never shown as a value.
  if (!Number.isSafeInteger(numerator) || (!signed && numerator < 0) || !Number.isSafeInteger(denominator) || denominator < 0) return na("INVALID_INPUT");
  if (denominator === 0) return na("ZERO_DENOMINATOR");
  const value = numerator / denominator;
  return caveat ? { state: "provisional", value, reasonCode: caveat } : { state: "known", value, reasonCode: null };
}

const roundMinor = (r: MetricResult): MetricResult => (r.value === null ? r : { ...r, value: Math.round(r.value) });

/** AOV = net receipts / valid orders. Result in minor units. */
export const aov = (netReceiptsMinor: number | null, validOrders: number | null, caveat?: Caveat | null) => roundMinor(divide(netReceiptsMinor, validOrders, caveat));

/** Contribution is signed: a refund can produce a loss per valid order. */
export const contributionPerOrder = (contributionMinor: number | null, validOrders: number | null) => roundMinor(divide(contributionMinor, validOrders, null, true));

/** Blended CAC = included acquisition cost / new retained customers. Result in minor units; a known zero cost stays $0. */
export const blendedCac = (acquisitionCostMinor: number | null, newRetainedCustomers: number | null, caveat?: Caveat | null) => roundMinor(divide(acquisitionCostMinor, newRetainedCustomers, caveat));

/** MER = net receipts / total marketing spend in the same scope. A multiple, not a percentage. */
export const mer = (netReceiptsMinor: number | null, marketingSpendMinor: number | null, caveat?: Caveat | null) => divide(netReceiptsMinor, marketingSpendMinor, caveat);

/** Platform ROAS = that platform's reported purchase value / that platform's spend. Never summed across platforms. */
export const platformRoas = (platformPurchaseValueMinor: number | null, platformSpendMinor: number | null) => divide(platformPurchaseValueMinor, platformSpendMinor);

export { allocateCosts } from "./economicCosts";
export type { CostBasis, CostBucket } from "./economicCosts";

export const CAVEAT_TEXT: Record<Caveat, string> = {
  LANDED_COST_INCOMPLETE: "Provisional · landed cost incomplete",
  RETENTION_IMMATURE: "Provisional · retention window not yet mature",
  ACCOUNTING_MONTH_OPEN: "Provisional · accounting month open",
  ESTIMATED_COST: "Provisional · includes estimated cost",
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
  ESTIMATED_COST: ["cac", "mer"],
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

type ScopeDimensions = Pick<CostScope, "cohortId" | "currency" | "period">;
function sameScope(left: ScopeDimensions, right: ScopeDimensions) {
  return left.cohortId === right.cohortId && left.currency === right.currency && sameReportingWindow(left.period, right.period);
}

/** Only the source-owned report scope selects the period. The label is presentation text. */
export function periodHeadline(data: AttributionData) {
  const e = data.headlineEvidence;
  const allocation = e ? reconcileEconomicCosts(e.costs, e.costScope) : null;
  const reasons = new Set(allocation?.diagnostics ?? []);
  const source = data.datasetKey === "attribution-observed" ? "source" : "fixture";
  const report = data.reportScope;
  const validBinding = (binding: MetricObservationScope | undefined) =>
    !!binding && binding.source === source && !!binding.sourceRef.trim() && !!binding.cohortId.trim() &&
    binding.currency === "USD" && validReportingWindow(binding.period);
  const reportBound = validBinding(report);
  if (!reportBound) reasons.add("REPORT_SCOPE_UNVERIFIED");
  if (!e) reasons.add("COST_EVIDENCE_MISSING");
  if (e && source !== e.source) reasons.add("SOURCE_DATASET_MISMATCH");
  if (e && (e.cohortId !== e.costScope.cohortId || !sameReportingWindow(e.cohortWindow, e.costScope.period) ||
      (report && !sameScope(report, e.costScope)))) reasons.add("COHORT_SCOPE_MISMATCH");
  if (allocation?.totalMinor != null && data.marketingSpend && (allocation.totalMinor !== data.marketingSpend.minorUnits ||
      data.marketingSpend.currency !== report?.currency)) reasons.add("REPORTED_SPEND_MISMATCH");
  const cost = reasons.size ? null : allocation?.totalMinor ?? null;

  // The order mirror and retained-customer ledger can have different coverage. Hold only the ratios that depend on a mismatched input.
  const boundToReport = (binding: MetricObservationScope | undefined) =>
    reportBound && !!report && !!binding && validBinding(binding) && sameScope(report, binding);
  const receiptsBound = boundToReport(data.receiptScope) && (!data.netReceipts.value || data.netReceipts.value.currency === report?.currency);
  const retainedBound = boundToReport(data.retainedCustomerScope);
  if (!receiptsBound) reasons.add("RECEIPT_SCOPE_UNVERIFIED");
  if (!retainedBound) reasons.add("RETAINED_CUSTOMER_SCOPE_UNVERIFIED");
  const costCaveat = e?.landedCost !== "complete" ? "LANDED_COST_INCOMPLETE" : allocation?.state === "provisional" ? "ESTIMATED_COST" : null;
  const customerCount = retainedBound && e && e.retention !== "unknown" ? data.newRetainedCustomers : null;
  const cac = blendedCac(cost, customerCount, e?.retention === "immature" ? "RETENTION_IMMATURE" : costCaveat);
  const merValue = mer(receiptsBound ? data.netReceipts.value?.minorUnits ?? null : null, cost, costCaveat);
  return { allocation, diagnostics: [...reasons].sort(), cost, receiptsBound, customerCount, cac, mer: merValue };
}
