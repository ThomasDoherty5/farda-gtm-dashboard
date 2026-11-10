/**
 * Unit economics for the finance dashboard cohort: gross margin, pre-marketing contribution, CAC and CAC payback in orders,
 * and the MRR/ARR gate. Pure functions over source rows; nothing here reads a provider.
 *
 * Counting rules (each cost is counted once):
 * - Every cost is an observation of one obligation. Rows that share an `obligationId` are one cost: an accrual and the
 *   cash that settles it (a commission payout, a paid content fee, a settled media invoice) are never added twice.
 *   `allocateCosts` from analytics enforces this and refuses conflicting amounts, cohorts, currencies and windows.
 * - Contribution components (landed COGS, shipping, provider fees, fulfillment) and acquisition components (paid media,
 *   sample landed cost, sample shipping, historical content fees, accrued commission) are disjoint, so a sample's landed
 *   cost is acquisition, not COGS, and a provider fee is contribution, not acquisition.
 * - A component with no row must be declared: a known zero, not applicable, or unknown. An undeclared or unknown
 *   component makes the metric N/A. Unknown is never zero.
 * - Rows from another cohort (for example the commission pilot) make the result N/A instead of being mixed in.
 *
 * Definitions are proposed until an owner adopts them; nothing here states professional or CPA validation.
 */
import type { ProvenanceValue } from "@/adapter/contract";
import { allocateCosts, type CostBasis, type ReportingWindow } from "@/features/analytics/economicCosts";

export const UNIT_ECONOMICS_VERSION = "finance-unit-economics@1";

export const CONTRIBUTION_COMPONENTS = ["landedCogs", "shipping", "providerFees", "fulfillment"] as const;
export const ACQUISITION_COMPONENTS = ["paidMedia", "sampleLanded", "sampleShipping", "historicalContentFee", "commission"] as const;
export type ContributionComponent = (typeof CONTRIBUTION_COMPONENTS)[number];
export type AcquisitionComponent = (typeof ACQUISITION_COMPONENTS)[number];
export type CostComponent = ContributionComponent | AcquisitionComponent;

export const COMPONENT_LABEL: Record<CostComponent, string> = {
  landedCogs: "Landed COGS", shipping: "Customer shipping", providerFees: "Provider fees", fulfillment: "Fulfillment",
  paidMedia: "Paid media", sampleLanded: "Sample landed cost", sampleShipping: "Sample shipping", historicalContentFee: "Historical content fees", commission: "Accrued commission",
};

/** One observation of one cost obligation, in minor units at source precision. A settlement row repeats its accrual's obligation. */
export type CostObservation = {
  component: CostComponent;
  basis: CostBasis;
  minorUnits: number | null;
  cohortId: string;
  obligationId: string;
  evidenceId: string;
  /** The cash settlement that paid this obligation, or null while it is only accrued or estimated. */
  cashId: string | null;
  currency: string;
  period: ReportingWindow;
};

/** A component with no cost row, stated explicitly. */
export type DeclaredComponent = { component: CostComponent; state: "knownZero" | "notApplicable" | "unknown"; reasonCode: string };
export type Coverage = { state: "complete" | "partial" | "unknown"; expected: number | null; observed: number | null; reasonCodes: string[] };
/** No policy is adopted in this repository, so demo definitions are "proposed". "adopted" needs the owner's reference. */
export type DefinitionPolicy = { version: string; state: "proposed" | "notConfigured" | "adopted"; reference: string | null };

export type UnitEconomicsInput = {
  definition: DefinitionPolicy;
  cohort: { id: string; label: string; currency: string; period: ReportingWindow };
  validOrders: ProvenanceValue<number>;
  newCustomers: ProvenanceValue<number>;
  landedCost: { complete: boolean; missingSkus: string[] };
  creatorCosts: Coverage;
  attribution: Coverage;
  costs: CostObservation[];
  declared: DeclaredComponent[];
};

export type SubscriptionSource = {
  /** "unknown" means the subscription source was not read. It is never shown as "no subscription revenue". */
  access: "unknown" | "verified";
  reasonCode: string | null;
  /** Verified subscription products. Null unless access is verified. */
  subscriptionProducts: number | null;
  definition: DefinitionPolicy;
  /** Recurring subscription revenue for the month. One-time orders never enter it. */
  monthlyRecurring: ProvenanceValue<number>;
};

export type Figure = { state: "known" | "provisional" | "notApplicable"; value: number | null; reasons: string[] };

export const REASON_TEXT: Record<string, string> = {
  NO_NET_REVENUE: "No net revenue in the period",
  NO_VALID_ORDERS: "No valid orders in the cohort",
  ORDERS_UNKNOWN: "Valid orders are not reported",
  NEW_CUSTOMERS_UNKNOWN: "New customers are not reported",
  NO_NEW_CUSTOMERS: "No new customers in the cohort",
  LANDED_COST_INCOMPLETE: "Landed cost incomplete",
  LANDED_COGS_DOES_NOT_TIE: "Landed COGS does not tie to the P&L",
  SOURCE_PER_ORDER_DOES_NOT_TIE: "Source per-order contribution does not tie to its components",
  CONTRIBUTION_NOT_POSITIVE: "Contribution per order is not positive, so acquisition cost is never paid back",
  CREATOR_COSTS_PARTIAL: "Creator costs partly allocated",
  CREATOR_COST_COVERAGE_UNKNOWN: "Creator-cost coverage is unknown",
  ATTRIBUTION_PARTIAL: "Attribution coverage incomplete",
  ATTRIBUTION_UNKNOWN: "Attribution coverage unknown",
  ESTIMATED_COST: "Includes estimated cost",
  COST_COHORT_MISMATCH: "A cost row belongs to another cohort",
  OBLIGATION_AMOUNT_CONFLICT: "One obligation is reported with two amounts",
  CURRENCY_MISMATCH: "Costs are in more than one currency",
  REPORTING_WINDOW_MISMATCH: "Costs cover a different window",
  INPUT_UNAVAILABLE: "An input is unavailable",
};
const reasonText = (code: string) => REASON_TEXT[code] ?? (code.startsWith("COMPONENT_") ? componentReason(code) : `Unresolved cost rows (${code})`);
function componentReason(code: string) {
  const [, kind, component] = /^COMPONENT_(UNKNOWN|UNDECLARED)_(\w+)$/.exec(code) ?? [];
  const label = COMPONENT_LABEL[component as CostComponent] ?? component;
  return kind === "UNKNOWN" ? `${label} unknown` : `${label} not reported`;
}
export const explain = (f: Figure) => f.reasons.map(reasonText).join(" · ");

const na = (...reasons: string[]): Figure => ({ state: "notApplicable", value: null, reasons });
const knownCount = (v: ProvenanceValue<number>) => (v.state === "known" && v.value !== null ? v.value : null);
const conditions = (reasons: string[], value: number): Figure => ({ state: reasons.length ? "provisional" : "known", value, reasons });

/** Total of one disjoint group of components, each obligation once. N/A when any component is unknown, undeclared or conflicting. */
export function componentTotal(ue: UnitEconomicsInput, components: readonly CostComponent[]): Figure {
  const rows = ue.costs.filter((c) => components.includes(c.component));
  const missing: string[] = [];
  for (const component of components) {
    if (rows.some((r) => r.component === component)) continue;
    const declared = ue.declared.find((d) => d.component === component);
    if (!declared) missing.push(`COMPONENT_UNDECLARED_${component}`);
    else if (declared.state === "unknown") missing.push(`COMPONENT_UNKNOWN_${component}`);
  }
  if (missing.length) return na(...missing);
  if (!rows.length) return { state: "known", value: 0, reasons: [] };
  const allocation = allocateCosts(
    rows.map((r) => ({ key: r.component, label: COMPONENT_LABEL[r.component], basis: r.basis, minorUnits: r.minorUnits, alsoInCash: r.cashId !== null, cohortId: r.cohortId, obligationId: r.obligationId, evidenceId: r.evidenceId, cashId: r.cashId, currency: r.currency, period: r.period })),
    { cohortId: ue.cohort.id, currency: ue.cohort.currency, period: ue.cohort.period, coverage: "complete" },
  );
  if (allocation.state === "unresolved" || allocation.totalMinor === null) return na(...allocation.diagnostics);
  return conditions(allocation.state === "provisional" ? ["ESTIMATED_COST"] : [], allocation.totalMinor);
}

/** Gross profit over net revenue, from the P&L. Provisional while any landed cost is missing. */
export function grossMarginOf(pnl: { revenue: number; cogs: number }, ue: UnitEconomicsInput): Figure {
  if (pnl.revenue <= 0) return na("NO_NET_REVENUE");
  return conditions(ue.landedCost.complete ? [] : ["LANDED_COST_INCOMPLETE"], (100 * (pnl.revenue - pnl.cogs)) / pnl.revenue);
}

/** Pre-marketing contribution: net revenue less landed COGS, shipping, provider fees and fulfillment. No acquisition cost. */
export function contributionOf(pnl: { revenue: number; cogs: number }, ue: UnitEconomicsInput, sourcePerOrder?: number): { total: Figure; perOrder: Figure } {
  const costs = componentTotal(ue, CONTRIBUTION_COMPONENTS);
  if (costs.state === "notApplicable" || costs.value === null) return { total: costs, perOrder: costs };
  const cogs = componentTotal(ue, ["landedCogs"]);
  if (cogs.value !== pnl.cogs) return { total: na("LANDED_COGS_DOES_NOT_TIE"), perOrder: na("LANDED_COGS_DOES_NOT_TIE") };
  const reasons = [...(ue.landedCost.complete ? [] : ["LANDED_COST_INCOMPLETE"]), ...costs.reasons];
  const total = conditions(reasons, pnl.revenue - costs.value);
  const orders = knownCount(ue.validOrders);
  if (orders === null) return { total, perOrder: na("ORDERS_UNKNOWN") };
  if (orders === 0) return { total, perOrder: na("NO_VALID_ORDERS") };
  const perOrder = total.value! / orders;
  if (sourcePerOrder !== undefined && Math.round(perOrder) !== sourcePerOrder) return { total, perOrder: na("SOURCE_PER_ORDER_DOES_NOT_TIE") };
  return { total, perOrder: conditions(reasons, perOrder) };
}

/** Acquisition cost and CAC over new customers, and CAC payback: how many orders of pre-marketing contribution repay one CAC. */
export function cacPaybackOf(pnl: { revenue: number; cogs: number }, ue: UnitEconomicsInput, sourcePerOrder?: number): { acquisition: Figure; cac: Figure; paybackOrders: Figure } {
  const rows = componentTotal(ue, ACQUISITION_COMPONENTS);
  const creator = ue.creatorCosts.state === "partial" ? ["CREATOR_COSTS_PARTIAL"] : [];
  const attribution = ue.attribution.state === "partial" ? ["ATTRIBUTION_PARTIAL"] : ue.attribution.state === "unknown" ? ["ATTRIBUTION_UNKNOWN"] : [];
  // Creator costs with unknown coverage could be any size, so the total is not shown; partial coverage is a floor, so it is provisional.
  const acquisition = rows.state === "notApplicable" ? rows : ue.creatorCosts.state === "unknown" ? na("CREATOR_COST_COVERAGE_UNKNOWN") : conditions([...rows.reasons, ...creator], rows.value!);
  const customers = knownCount(ue.newCustomers);
  let cac: Figure;
  if (acquisition.state === "notApplicable") cac = acquisition;
  else if (customers === null) cac = na("NEW_CUSTOMERS_UNKNOWN");
  else if (customers === 0) cac = na("NO_NEW_CUSTOMERS");
  else cac = conditions([...acquisition.reasons, ...attribution], acquisition.value! / customers);
  const { perOrder } = contributionOf(pnl, ue, sourcePerOrder);
  let paybackOrders: Figure;
  if (cac.state === "notApplicable") paybackOrders = cac;
  else if (perOrder.state === "notApplicable") paybackOrders = perOrder;
  else if (perOrder.value! <= 0) paybackOrders = na("CONTRIBUTION_NOT_POSITIVE");
  else paybackOrders = conditions([...new Set([...perOrder.reasons, ...cac.reasons])], cac.value! / perOrder.value!);
  return { acquisition, cac, paybackOrders };
}

export type RecurringRevenue =
  | { kind: "unavailable"; reason: string }
  | { kind: "none"; reason: string }
  | { kind: "notDefined"; reason: string }
  | { kind: "unknown"; reason: string }
  | { kind: "known"; mrr: number; arr: number; reason: string };

/**
 * MRR and ARR need verified access to the subscription source, a verified subscription product and an adopted recurring-revenue
 * definition. Unread access is "unavailable", which is not the verified "none". Order revenue is never an input, so one-time
 * orders can't be annualized.
 */
export function recurringRevenueOf(s: SubscriptionSource): RecurringRevenue {
  if (s.access !== "verified" || s.subscriptionProducts === null)
    return { kind: "unavailable", reason: `Subscription source not read${s.reasonCode ? ` (${s.reasonCode})` : ""}. Unknown, not zero.` };
  if (s.subscriptionProducts === 0) return { kind: "none", reason: "Verified: the source has no subscription product." };
  if (s.definition.state !== "adopted" || !s.definition.reference)
    return { kind: "notDefined", reason: `${s.subscriptionProducts} subscription product${s.subscriptionProducts === 1 ? "" : "s"} verified. No recurring-revenue definition is adopted, so MRR and ARR are N/A.` };
  const mrr = knownCount(s.monthlyRecurring);
  if (mrr === null) return { kind: "unknown", reason: "Recurring subscription revenue is not reported." };
  return { kind: "known", mrr, arr: mrr * 12, reason: `Recurring subscription revenue only, per ${s.definition.reference}.` };
}

/** "6 of 8 creators", or "creators unknown". Unknown coverage is never shown as 0 of n. */
export const coverageText = (c: Coverage, noun: string) =>
  c.state === "unknown" || c.expected === null || c.observed === null ? `${noun} unknown` : `${c.observed} of ${c.expected} ${noun}`;

export const definitionText = (d: DefinitionPolicy) =>
  d.state === "adopted" && d.reference ? `Adopted · ${d.reference}` : d.state === "proposed" ? `Proposed · ${d.version} · not adopted` : "Not configured";

/** Display text: the value, a provisional label with its reasons, or N/A with its reason. */
export function figureText(f: Figure, format: (v: number) => string): string {
  if (f.state === "notApplicable" || f.value === null) return `N/A · ${explain(f) || REASON_TEXT.INPUT_UNAVAILABLE}`;
  return f.state === "provisional" ? `${format(f.value)} · Provisional · ${explain(f)}` : format(f.value);
}

/** Display formats. Money keeps source precision until display, then shows cents. */
export const ueFormat = {
  percent: (v: number) => `${v.toFixed(1)}%`,
  money: (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(minor / 100),
  orders: (v: number) => `${v.toFixed(2)} orders`,
};

/** MRR and ARR as display text. "None" only for a verified absence; an unread source is "Unknown". */
export function recurringText(r: RecurringRevenue): { mrr: string; arr: string } {
  if (r.kind === "known") return { mrr: ueFormat.money(r.mrr), arr: ueFormat.money(r.arr) };
  const text = r.kind === "none" ? "None" : r.kind === "notDefined" ? "N/A" : "Unknown";
  return { mrr: text, arr: text };
}
