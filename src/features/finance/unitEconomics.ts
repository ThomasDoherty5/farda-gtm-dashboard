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
import { financeCohortMatches, financeHeadlines, type FinanceSummaryContext } from "@/creator-agent/finance/headlines";
import { allocateCosts, type CostBasis, type ReportingWindow } from "@/features/analytics/economicCosts";
import type { FinanceDashboard as DemoFinanceDashboard } from "@/fixtures/finance";

export type FinanceDisplayRecord = Omit<DemoFinanceDashboard, "datasetKey"> & {
  datasetKey: "finance-demo" | "finance-native";
  summaryContext?: FinanceSummaryContext | null;
  provenance?: { observedAt: string; evidenceStage: "synthetic" | "source" };
};

export const UNIT_ECONOMICS_VERSION = "finance-unit-economics@1";
/** The management P&L is reported in USD minor units; a cohort in another currency can't be combined with it. */
export const PNL_CURRENCY = "USD";

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
  ACCOUNTING_REPORT_DEFINITION_UNAVAILABLE: "Approved accounting report definition unavailable",
  UNIT_ECONOMICS_DEFINITION_UNADOPTED: "Unit-economics definition awaits owner adoption",
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
  CURRENCY_MISMATCH: "Costs are in a currency other than the cohort's",
  REPORTING_WINDOW_MISMATCH: "Costs cover a different window",
  INPUT_UNAVAILABLE: "An input is unavailable",
  UNIT_ECONOMICS_NOT_REPORTED: "Unit-economics inputs are not reported",
  LANDED_COST_COMPLETENESS_UNKNOWN: "Landed-cost completeness not reported",
  OBLIGATION_COMPONENT_CONFLICT: "One obligation is reported under two cost components",
  COHORT_CURRENCY_MISMATCH: "The cohort currency differs from the P&L currency",
  EVIDENCE_CONFLICT: "One evidence record is used for two different costs",
  CASH_ALLOCATION_CONFLICT: "One cash settlement is used for two obligations",
  MULTIPLE_SETTLEMENTS_UNRECONCILED: "One obligation has two unreconciled settlements",
  CASH_IDENTITY_UNRESOLVED: "A paid cost has no cash settlement reference",
  ESTIMATED_CASH_UNVERIFIED: "An estimated cost claims a cash settlement",
  INVALID_ECONOMIC_IDENTITY: "A cost reference has invisible characters or surrounding spaces",
};

/**
 * Cohort, obligation, evidence and cash IDs are opaque and case-sensitive: they match only when identical, with no trimming,
 * case folding or Unicode normalization. An ID with leading or trailing whitespace, a control or format character (zero-width
 * space, joiner, byte-order mark, soft hyphen) or a blank-looking space other than U+0020 is refused, never silently matched.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u115F\u1160\u1680\u2000-\u200A\u202F\u205F\u2800\u3000\u3164\uFFA0]/u;
export const isOpaqueId = (id: string) => id.length > 0 && id === id.trim() && !INVISIBLE.test(id);
/** Plain words only; a reason code is never shown to people. */
const reasonText = (code: string) => REASON_TEXT[code] ?? (code.startsWith("COMPONENT_") ? componentReason(code) : "The cost rows could not be reconciled");
function componentReason(code: string) {
  const [, kind, component] = /^COMPONENT_(UNKNOWN|UNDECLARED|CONFLICT)_(\w+)$/.exec(code) ?? [];
  const label = COMPONENT_LABEL[component as CostComponent] ?? component;
  return kind === "UNKNOWN" ? `${label} unknown` : kind === "CONFLICT" ? `${label} is both declared and reported` : `${label} not reported`;
}
export const explain = (f: Figure) => f.reasons.map(reasonText).join(" · ");

const na = (...reasons: string[]): Figure => ({ state: "notApplicable", value: null, reasons });
const knownCount = (v: ProvenanceValue<number>) => (v.state === "known" && v.value !== null ? v.value : null);
const conditions = (reasons: string[], value: number): Figure => ({ state: reasons.length ? "provisional" : "known", value, reasons });

const bucketOf = (r: CostObservation) => ({ key: r.component, label: COMPONENT_LABEL[r.component], basis: r.basis, minorUnits: r.minorUnits, alsoInCash: r.cashId !== null,
  cohortId: r.cohortId, obligationId: r.obligationId, evidenceId: r.evidenceId, cashId: r.cashId, currency: r.currency, period: r.period });
const scopeOf = (ue: UnitEconomicsInput) => ({ cohortId: ue.cohort.id, currency: ue.cohort.currency, period: ue.cohort.period, coverage: "complete" as const });

/**
 * Problems with the whole input that make every cost figure N/A: a cohort currency other than the P&L's, one obligation under two
 * components (it would be counted in both), or a component both declared and reported. Checked across all rows, not per group,
 * so per-component totals always sum to their group's total.
 */
export function inputProblems(ue: UnitEconomicsInput): string[] {
  const problems: string[] = [];
  // A cohort in another currency can't be combined with the P&L at all; its rows aren't examined further.
  if (ue.cohort.currency !== PNL_CURRENCY) return ["COHORT_CURRENCY_MISMATCH"];
  const ids = [ue.cohort.id, ...ue.costs.flatMap((r) => [r.cohortId, r.obligationId, r.evidenceId, ...(r.cashId === null ? [] : [r.cashId])])];
  if (ids.some((id) => !isOpaqueId(id))) problems.push("INVALID_ECONOMIC_IDENTITY");
  const owner = new Map<string, CostComponent>();
  for (const row of ue.costs) {
    const seen = owner.get(row.obligationId);
    if (seen && seen !== row.component) { problems.push("OBLIGATION_COMPONENT_CONFLICT"); break; }
    owner.set(row.obligationId, row.component);
  }
  for (const d of ue.declared) if (ue.costs.some((r) => r.component === d.component)) problems.push(`COMPONENT_CONFLICT_${d.component}`);
  // One pass over every row, across both groups, so evidence or cash shared between a contribution and an acquisition cost surfaces.
  if (ue.costs.length) problems.push(...allocateCosts(ue.costs.map(bucketOf), scopeOf(ue)).diagnostics);
  return [...new Set(problems)];
}

/** Total of one disjoint group of components, each obligation once. N/A when inputs are missing, unknown, undeclared or conflicting. */
export function componentTotal(ue: UnitEconomicsInput | undefined, components: readonly CostComponent[]): Figure {
  if (!ue) return na("UNIT_ECONOMICS_NOT_REPORTED");
  const problems = inputProblems(ue);
  if (problems.length) return na(...problems);
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
  const allocation = allocateCosts(rows.map(bucketOf), scopeOf(ue));
  if (allocation.state === "unresolved" || allocation.totalMinor === null) return na(...allocation.diagnostics);
  return conditions(allocation.state === "provisional" ? ["ESTIMATED_COST"] : [], allocation.totalMinor);
}

/** Gross profit over net revenue, from the P&L. Provisional while any landed cost is missing, or while completeness isn't reported. */
export function grossMarginOf(pnl: { revenue: number; cogs: number }, ue: UnitEconomicsInput | undefined): Figure {
  if (pnl.revenue <= 0) return na("NO_NET_REVENUE");
  const reasons = !ue ? ["LANDED_COST_COMPLETENESS_UNKNOWN"] : ue.landedCost.complete ? [] : ["LANDED_COST_INCOMPLETE"];
  return conditions(reasons, (100 * (pnl.revenue - pnl.cogs)) / pnl.revenue);
}

/**
 * Tolerance for the source's own per-order figure. The source states whole minor units after its own rounding (half-up, half-even
 * or truncation), so the exact derived value may differ from it by under one minor unit; a difference above one is a real mismatch.
 */
export const PER_ORDER_TIE_TOLERANCE_MINOR = 1;

/** Pre-marketing contribution: net revenue less landed COGS, shipping, provider fees and fulfillment. No acquisition cost. */
export function contributionOf(pnl: { revenue: number; cogs: number }, ue: UnitEconomicsInput | undefined, sourcePerOrder?: number): { total: Figure; perOrder: Figure } {
  const costs = componentTotal(ue, CONTRIBUTION_COMPONENTS);
  if (!ue || costs.state === "notApplicable" || costs.value === null) return { total: costs, perOrder: costs };
  const cogs = componentTotal(ue, ["landedCogs"]);
  if (cogs.value !== pnl.cogs) return { total: na("LANDED_COGS_DOES_NOT_TIE"), perOrder: na("LANDED_COGS_DOES_NOT_TIE") };
  const reasons = [...(ue.landedCost.complete ? [] : ["LANDED_COST_INCOMPLETE"]), ...costs.reasons];
  const total = conditions(reasons, pnl.revenue - costs.value);
  const orders = knownCount(ue.validOrders);
  if (orders === null) return { total, perOrder: na("ORDERS_UNKNOWN") };
  if (orders === 0) return { total, perOrder: na("NO_VALID_ORDERS") };
  const perOrder = total.value! / orders;
  if (sourcePerOrder !== undefined && Math.abs(perOrder - sourcePerOrder) > PER_ORDER_TIE_TOLERANCE_MINOR) return { total, perOrder: na("SOURCE_PER_ORDER_DOES_NOT_TIE") };
  return { total, perOrder: conditions(reasons, perOrder) };
}

/** Acquisition cost and CAC over new customers, and CAC payback: how many orders of pre-marketing contribution repay one CAC. */
export function cacPaybackOf(pnl: { revenue: number; cogs: number }, ue: UnitEconomicsInput | undefined, sourcePerOrder?: number): { acquisition: Figure; cac: Figure; paybackOrders: Figure } {
  const rows = componentTotal(ue, ACQUISITION_COMPONENTS);
  if (!ue) return { acquisition: rows, cac: rows, paybackOrders: rows };
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

/** Both finance views use the same source-qualified inputs and the same figures. */
export function financeEconomicsOf(data: FinanceDisplayRecord) {
  const native = data.datasetKey === "finance-native";
  const headlines = native ? financeHeadlines(data) : null;
  const supplied = data.unitEconomics;
  const input = native && supplied && !financeCohortMatches(data.summaryContext, supplied.cohort) ? undefined : supplied;
  if (headlines?.reason) {
    const held = na("ACCOUNTING_REPORT_DEFINITION_UNAVAILABLE");
    return { input, margin: held, perOrder: held, cac: held, paybackOrders: held };
  }
  const computedMargin = grossMarginOf(data.pnl, input);
  const margin = headlines
    ? headlines.grossMargin === null ? na("NO_NET_REVENUE") : { ...computedMargin, value: headlines.grossMargin }
    : computedMargin;
  const derived = contributionOf(data.pnl, input, data.contributionPerOrder).perOrder;
  const { cac, paybackOrders } = cacPaybackOf(data.pnl, input, data.contributionPerOrder);
  const qualify = (value: Figure) => native && value.value !== null && input?.definition.state !== "adopted"
    ? conditions([...value.reasons, "UNIT_ECONOMICS_DEFINITION_UNADOPTED"], value.value)
    : value;
  // A qualified legacy source can still display its own reported figure. It is not an input to calculated CAC.
  const perOrder = native && !supplied
    ? conditions(["UNIT_ECONOMICS_NOT_REPORTED"], data.contributionPerOrder)
    : qualify(derived);
  return { input, margin, perOrder, cac: qualify(cac), paybackOrders: qualify(paybackOrders) };
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
export function recurringRevenueOf(s: SubscriptionSource | undefined): RecurringRevenue {
  if (!s) return { kind: "unavailable", reason: "Subscription source not reported. Unknown, not zero." };
  if (s.access !== "verified" || s.subscriptionProducts === null)
    return { kind: "unavailable", reason: "Subscription source not read. Unknown, not zero." };
  if (s.subscriptionProducts === 0) return { kind: "none", reason: "Verified: the source has no subscription product." };
  if (s.definition.state !== "adopted" || !s.definition.reference)
    return { kind: "notDefined", reason: `${s.subscriptionProducts} subscription product${s.subscriptionProducts === 1 ? "" : "s"} verified. No recurring-revenue definition is adopted, so MRR and ARR are N/A.` };
  const mrr = knownCount(s.monthlyRecurring);
  if (mrr === null) return { kind: "unknown", reason: "Recurring subscription revenue is not reported." };
  return { kind: "known", mrr, arr: mrr * 12, reason: `Recurring subscription revenue only, per ${s.definition.reference}.` };
}

/** "6 of 8 creators allocated", or "Unknown". Unknown coverage is never shown as 0 of n. */
export const coverageText = (c: Coverage, noun: string) =>
  c.state === "unknown" || c.expected === null || c.observed === null ? "Unknown" : `${c.observed} of ${c.expected} ${noun}`;

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
